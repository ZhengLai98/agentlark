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
  stdin: { write(data: string): void; end(): void };
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
          { code, stderrTail },
          'agent: exited without a result line',
        );
        const detail = stderrTail.trim();
        settle({
          ok: false,
          text: detail
            ? `模型执行失败 (退出码 ${code}):\n\`\`\`\n${detail}\n\`\`\``
            : `模型执行失败 (退出码 ${code}), 且没有输出。详见 runtime/logs/bot.log。`,
          sessionId,
        });
      });

      child.stdin.write(input.prompt);
      child.stdin.end();
    });
}
