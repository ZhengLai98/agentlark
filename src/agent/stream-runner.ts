import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Logger } from '../infra/logger';
import type {
  AgentEvent,
  AgentResult,
  RunAgent,
  RunAgentInput,
} from '../types/agent';
import { buildAgentArgs } from './args';
import { buildChildEnv } from './child-env';
import { createStreamParser } from './stream-parser';

/** 超时 SIGTERM 后再等多久补 SIGKILL。 */
const KILL_GRACE_MS = 3000;
/** 失败时附带的 stderr 尾巴长度。 */
const STDERR_TAIL = 600;

export interface ChildProcessLike {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write(data: string, callback?: (error?: Error | null) => void): void;
    end(): void;
    /** 必须监听: 无监听器时 Node 的 stream 'error' 会抛到 uncaughtException, 直接带走整个进程。 */
    on(event: 'error', listener: (error: Error) => void): void;
  };
  on(event: 'close' | 'error', listener: (...args: any[]) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcessLike;

export interface AgentRunnerDeps {
  bin: string;
  model: string;
  permissionMode: string;
  timeoutMs: number;
  cwd: string;
  logger: Logger;
  /** 测试注入假实现。 */
  spawnFn?: SpawnFn;
}

/**
 * spawn claude headless 子进程, 边跑边把事件回调出去, 结束返回终态。
 * 永远 resolve, 不 reject —— 失败也是一条要发给用户的可读消息。
 */
export function createAgentRunner(deps: AgentRunnerDeps): RunAgent {
  const spawnFn: SpawnFn = deps.spawnFn ?? (spawn as unknown as SpawnFn);

  return (input: RunAgentInput, onEvent: (event: AgentEvent) => void) =>
    new Promise<AgentResult>((resolve) => {
      const args = buildAgentArgs({
        model: deps.model,
        permissionMode: deps.permissionMode,
        resumeSessionId: input.resumeSessionId,
      });

      let sessionId = input.resumeSessionId ?? '';
      let finalResult: AgentResult | null = null;
      let streamedText = '';
      let stderrTail = '';
      let settled = false;
      let stdinFailed = false;

      const parser = createStreamParser((event) => {
        if (event.type === 'session') sessionId = event.sessionId;
        if (event.type === 'text') streamedText += event.text;
        if (event.type === 'result') {
          if (event.sessionId) sessionId = event.sessionId;
          finalResult = {
            ok: event.ok,
            text: event.text,
            sessionId: event.sessionId || sessionId,
          };
        }
        onEvent(event);
      });

      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (result: AgentResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        resolve(result);
      };

      let child: ChildProcessLike;
      try {
        child = spawnFn(deps.bin, args, {
          cwd: deps.cwd,
          env: buildChildEnv(process.env),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        deps.logger.error({ err: error, bin: deps.bin }, 'agent: spawn threw');
        settle({
          ok: false,
          text: `启动模型失败: 找不到可执行文件 \`${deps.bin}\`。请用 \`which claude\` 拿到绝对路径写进 AGENT_BIN。`,
          sessionId,
        });
        return;
      }

      // 超时立刻给用户答复, 不等子进程真的退出 —— 卡死的子进程不该把用户一起卡住。
      // SIGKILL 兜底定时器刻意不随 settle 清掉, 保证进程一定被回收。
      timeoutTimer = setTimeout(() => {
        deps.logger.warn(
          { timeoutMs: deps.timeoutMs },
          'agent: timed out, sending SIGTERM',
        );
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        settle({
          ok: false,
          text: `模型调用超时 (${Math.round(deps.timeoutMs / 1000)} 秒)。可以拆成更小的问题再问一次, 或调大 AGENT_TIMEOUT_MS。`,
          sessionId,
        });
      }, deps.timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        parser.write(chunk.toString());
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL);
      });

      child.on('error', (error: Error) => {
        deps.logger.error({ err: error, bin: deps.bin }, 'agent: spawn failed');
        settle({
          ok: false,
          text: `启动模型失败: \`${deps.bin}\` 无法执行 (${error.message})。请用 \`which claude\` 拿到绝对路径写进 AGENT_BIN。`,
          sessionId,
        });
      });

      child.on('close', (code: number | null) => {
        if (killTimer !== null) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        parser.end();
        if (settled) return;

        if (finalResult) {
          settle(finalResult);
          return;
        }

        if (code === 0 && streamedText.trim().length > 0) {
          settle({ ok: true, text: streamedText, sessionId });
          return;
        }

        deps.logger.error(
          { code, stderrTail, stdinFailed },
          'agent: exited without a result line',
        );
        const detail = stderrTail.trim();
        if (detail) {
          settle({
            ok: false,
            text: `模型执行失败 (退出码 ${code}):\n\`\`\`\n${detail}\n\`\`\``,
            sessionId,
          });
          return;
        }
        settle({
          ok: false,
          text: stdinFailed
            ? `模型执行失败 (退出码 ${code}): 提示词没能写进子进程 stdin (管道已关闭)。多半是续接的会话 id 已失效, 发 /new 再问一次。`
            : `模型执行失败 (退出码 ${code}), 且没有输出。详见 runtime/logs/bot.log。`,
          sessionId,
        });
      });

      // stdin 失败不直接 settle: 走 close 分支的常规失败路径, 那里能带上 stderr 尾巴,
      // 对用户更有信息量; 子进程真卡死时还有 timeoutTimer 兜底。
      const onStdinError = (error: unknown): void => {
        stdinFailed = true;
        deps.logger.warn({ err: error, bin: deps.bin }, 'agent: stdin failed');
      };

      child.stdin.on('error', onStdinError);

      try {
        child.stdin.write(input.prompt, (error) => {
          if (error) onStdinError(error);
        });
        child.stdin.end();
      } catch (error) {
        // write/end 也可能同步抛 (如 write after end); 绝不能逃出 Promise executor
        onStdinError(error);
      }
    });
}
