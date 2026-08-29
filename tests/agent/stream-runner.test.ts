import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentRunner } from '../../src/agent/stream-runner';
import type { AgentEvent } from '../../src/types/agent';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  kill = vi.fn(() => true);

  emitLine(payload: unknown): void {
    this.stdout.emit('data', JSON.stringify(payload) + '\n');
  }
}

const makeRunner = (child: FakeChild, overrides = {}) => {
  const spawnFn = vi.fn().mockReturnValue(child);
  const run = createAgentRunner({
    bin: 'claude',
    model: '',
    permissionMode: 'bypassPermissions',
    timeoutMs: 5000,
    cwd: '/workspace',
    logger: logger as never,
    spawnFn: spawnFn as never,
    ...overrides,
  });
  return { run, spawnFn };
};

describe('createAgentRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('把 prompt 写进 stdin 而不是 argv', async () => {
    const child = new FakeChild();
    const { run, spawnFn } = makeRunner(child);

    const promise = run({ prompt: '帮我查一下 PV' }, () => {});
    expect(child.stdin.write).toHaveBeenCalledWith('帮我查一下 PV');
    expect(child.stdin.end).toHaveBeenCalled();
    expect(spawnFn.mock.calls[0][1]).not.toContain('帮我查一下 PV');

    child.emitLine({
      type: 'result',
      is_error: false,
      result: 'ok',
      session_id: 's1',
    });
    child.emit('close', 0);
    await promise;
  });

  it('spawn 用配置的 bin、cwd 与白名单 env', async () => {
    const child = new FakeChild();
    const { run, spawnFn } = makeRunner(child);

    const promise = run({ prompt: 'hi' }, () => {});
    const [command, , options] = spawnFn.mock.calls[0] as [string, string[], any];
    expect(command).toBe('claude');
    expect(options.cwd).toBe('/workspace');
    expect(options.env.FEISHU_APP_SECRET).toBeUndefined();

    child.emit('close', 0);
    await promise;
  });

  it('有 resumeSessionId 时传 --resume', async () => {
    const child = new FakeChild();
    const { run, spawnFn } = makeRunner(child);

    const promise = run({ prompt: 'hi', resumeSessionId: 'sess_old' }, () => {});
    expect(spawnFn.mock.calls[0][1]).toContain('--resume');
    child.emit('close', 0);
    await promise;
  });

  it('把解析出的事件回调给调用方并返回终态结果', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child);
    const events: AgentEvent[] = [];

    const promise = run({ prompt: 'hi' }, (e) => events.push(e));
    child.emitLine({ type: 'system', subtype: 'init', session_id: 'sess_new' });
    child.emitLine({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }],
      },
    });
    child.emitLine({
      type: 'result',
      is_error: false,
      result: '答案在这里',
      session_id: 'sess_new',
    });
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({
      ok: true,
      text: '答案在这里',
      sessionId: 'sess_new',
    });
    expect(events).toEqual([
      { type: 'session', sessionId: 'sess_new' },
      { type: 'tool', line: '📖 Read a.ts' },
      {
        type: 'result',
        ok: true,
        text: '答案在这里',
        sessionId: 'sess_new',
      },
    ]);
  });

  it('没有 result 行但退出码为 0 时回退到累积的文本', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child);

    const promise = run({ prompt: 'hi' }, () => {});
    child.emitLine({ type: 'system', subtype: 'init', session_id: 'sess_a' });
    child.emitLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '拼接答案' }] },
    });
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({
      ok: true,
      text: '拼接答案',
      sessionId: 'sess_a',
    });
  });

  it('非零退出码且无 result 时返回失败与 stderr 尾巴', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child);

    const promise = run({ prompt: 'hi' }, () => {});
    child.stderr.emit('data', 'fatal: model unavailable\n');
    child.emit('close', 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.text).toContain('model unavailable');
  });

  it('spawn ENOENT 转成可读失败, 不抛错', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child);

    const promise = run({ prompt: 'hi' }, () => {});
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    }));

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.text).toContain('AGENT_BIN');
  });

  it('超时后 kill 子进程并返回超时提示', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child, { timeoutMs: 1000 });

    const promise = run({ prompt: 'hi' }, () => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.text).toContain('超时');
  });

  it('超时后子进程赖着不走会补 SIGKILL', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child, { timeoutMs: 1000 });

    const promise = run({ prompt: 'hi' }, () => {});
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toMatchObject({ ok: false });

    await vi.advanceTimersByTimeAsync(3000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('正常结束后清掉超时定时器, 不会二次 kill', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child, { timeoutMs: 1000 });

    const promise = run({ prompt: 'hi' }, () => {});
    child.emitLine({
      type: 'result',
      is_error: false,
      result: 'ok',
      session_id: 's',
    });
    child.emit('close', 0);
    await promise;

    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
