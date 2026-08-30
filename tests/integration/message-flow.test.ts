import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore, sessionKey } from '../../src/agent/session-store';
import { createAgentRunner } from '../../src/agent/stream-runner';
import { handleMessageEvent } from '../../src/feishu/dispatcher';
import { createReplier } from '../../src/feishu/reply';
import { reactTyping } from '../../src/feishu/react';
import { openStreamCard } from '../../src/feishu/stream-card';
import { filterMessage } from '../../src/handler/filter';
import { createMessagePipeline } from '../../src/handler/message';
import { BoundedSet } from '../../src/infra/bounded-set';
import { ChatLock } from '../../src/infra/chat-lock';
import type { SessionStore } from '../../src/agent/session-store';

/**
 * 唯一的跨模块集成测试: 原始事件 → 真 parse → 真 filter → 真 ChatLock → 真 pipeline
 * (真 runner / 真 stream-parser / 真卡片渲染), 只假掉 FeishuApi 与 spawn。
 * 装配顺序刻意抄自 src/index.ts —— 那里的 wiring 没有别的测试覆盖。
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  kill = vi.fn(() => true);
}

/** 真实的 stream-json NDJSON, 刻意在半行处切开, 逼 parser 走缓冲分支。 */
const NDJSON_CHUNKS = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_int' }) +
    '\n' +
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read",',
  '"input":{"file_path":"/repo/src/app.ts"}}]}}\n',
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '昨天 PV 是 ' }] },
  }) + '\n',
  JSON.stringify({
    type: 'result',
    is_error: false,
    result: '昨天 PV 是 12345',
    session_id: 'sess_int',
  }) + '\n',
];

const makeSpawnFn = (chunks: string[] = NDJSON_CHUNKS, exitCode = 0) => {
  const children: FakeChild[] = [];
  const spawnFn = vi.fn((_command: string, _args: string[]) => {
    const child = new FakeChild();
    children.push(child);
    setTimeout(() => {
      for (const chunk of chunks) child.stdout.emit('data', chunk);
      child.emit('close', exitCode);
    }, 0);
    return child;
  });
  return { spawnFn, children };
};

const makeApi = () => ({
  sendMessage: vi.fn().mockResolvedValue('om_card_p2p'),
  replyMessage: vi.fn().mockResolvedValue('om_card_group'),
  patchMessage: vi.fn().mockResolvedValue(undefined),
  createReaction: vi.fn().mockResolvedValue(undefined),
  getBotOpenId: vi.fn().mockResolvedValue('ou_bot'),
});

const rawEvent = (overrides: Record<string, unknown> = {}) => ({
  sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
  message: {
    message_id: 'om_1',
    root_id: '',
    parent_id: '',
    create_time: '1700000000000',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '帮我查一下昨天的 PV' }),
    mentions: [],
    ...overrides,
  },
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentlark-int-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function createBot(opts: {
  api: ReturnType<typeof makeApi>;
  spawnFn: ReturnType<typeof makeSpawnFn>['spawnFn'];
  sessions?: SessionStore;
}) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  };

  const sessions =
    opts.sessions ??
    createSessionStore({
      file: join(dir, 'sessions.json'),
      maxIdleHours: 24,
    });

  const runAgent = createAgentRunner({
    bin: 'claude',
    model: '',
    permissionMode: 'bypassPermissions',
    timeoutMs: 5000,
    cwd: join(dir, 'workspace'),
    logger: logger as never,
    spawnFn: opts.spawnFn as never,
  });

  const pipeline = createMessagePipeline({
    sessions,
    runAgent,
    openCard: (target) =>
      openStreamCard(
        { api: opts.api, logger: logger as never, throttleMs: 0 },
        target,
      ),
    reply: createReplier(opts.api, logger as never),
    react: (messageId) => reactTyping(opts.api, messageId, logger as never),
    logger: logger as never,
  });

  const seen = new BoundedSet(100);
  const lock = new ChatLock();
  const pending: Array<Promise<void>> = [];

  const deliver = (raw: unknown): void => {
    handleMessageEvent(raw, logger as never, (msg) => {
      const decision = filterMessage(msg, {
        botOpenId: 'ou_bot',
        ignoreAtAll: true,
        allowedGroupChats: [],
        allowedUsers: [],
        seen,
      });
      if (decision.action === 'drop') return;

      // src/index.ts 的边界: rejection 必须在这里被接住
      pending.push(
        lock.run(sessionKey(msg), () => pipeline(msg)).catch((error) => {
          logger.error({ err: error }, 'index: pipeline rejected');
        }),
      );
    });
  };

  return {
    deliver,
    settle: () => Promise.all(pending),
    logger,
    sessions,
  };
}

describe('端到端: 飞书事件 → 卡片答案', () => {
  it('私聊提问建卡、刷进度、终态 patch 成模型答案, 并固化会话', async () => {
    const api = makeApi();
    const { spawnFn } = makeSpawnFn();
    const bot = createBot({ api, spawnFn });

    bot.deliver(rawEvent());
    await bot.settle();

    // 建卡: 私聊直发, 首帧思考中
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![0].content).toContain('💭 思考中');
    expect(api.replyMessage).not.toHaveBeenCalled();
    expect(api.createReaction).toHaveBeenCalledWith({
      messageId: 'om_1',
      emoji: 'Typing',
    });

    // 真 stream-parser 认出了 tool_use, 进度行进了某一帧卡片
    const patches = api.patchMessage.mock.calls.map((call) => call[0].content);
    expect(patches.some((c: string) => c.includes('📖 Read app.ts'))).toBe(true);

    // 终态是模型的答案
    const last = patches.at(-1)!;
    expect(last).toContain('昨天 PV 是 12345');
    expect(last).not.toContain('💭 思考中');

    // prompt 走 stdin, 不进 argv
    const args = spawnFn.mock.calls[0]![1];
    expect(args).toContain('--output-format');
    expect(args).not.toContain('帮我查一下昨天的 PV');

    expect(bot.sessions.get('p2p:ou_sender')).toBe('sess_int');
  });

  it('续问带上 --resume, 同会话串行处理', async () => {
    const api = makeApi();
    const { spawnFn } = makeSpawnFn();
    const bot = createBot({ api, spawnFn });

    bot.deliver(rawEvent());
    await bot.settle();
    bot.deliver(rawEvent({ message_id: 'om_2' }));
    await bot.settle();

    const secondArgs = spawnFn.mock.calls[1]![1];
    expect(secondArgs).toContain('--resume');
    expect(secondArgs).toContain('sess_int');
  });

  it('不支持的消息类型一个请求都不发', async () => {
    const api = makeApi();
    const { spawnFn } = makeSpawnFn();
    const bot = createBot({ api, spawnFn });

    bot.deliver(rawEvent({ message_type: 'image' }));
    await bot.settle();

    expect(spawnFn).not.toHaveBeenCalled();
    for (const fn of [
      api.sendMessage,
      api.replyMessage,
      api.patchMessage,
      api.createReaction,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('/new 落盘失败时仍然回复用户, 且不把 rejection 抛到装配点', async () => {
    const api = makeApi();
    const { spawnFn } = makeSpawnFn();
    const sessions: SessionStore = {
      get: () => undefined,
      set: () => undefined,
      clear: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    };
    const bot = createBot({ api, spawnFn, sessions });

    bot.deliver(rawEvent({ content: JSON.stringify({ text: '/new' }) }));
    await expect(bot.settle()).resolves.toBeDefined();

    // 用户拿到可读回复 (纯文本), 模型没被启动
    expect(spawnFn).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const sent = api.sendMessage.mock.calls[0]![0];
    expect(sent.msgType).toBe('text');
    expect(JSON.parse(sent.content).text).toContain('出错');

    // 边界的 catch 没有被触发 —— 流水线自己吞掉了错误
    expect(
      bot.logger.error.mock.calls.some(
        (call) => call[1] === 'index: pipeline rejected',
      ),
    ).toBe(false);
  });
});
