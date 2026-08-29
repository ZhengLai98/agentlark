import { describe, expect, it, vi } from 'vitest';
import { createMessagePipeline } from '../../src/handler/message';
import type { ParsedMessage } from '../../src/types/feishu';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const msg = (overrides: Partial<ParsedMessage> = {}): ParsedMessage => ({
  messageId: 'om_1',
  rootId: '',
  parentId: '',
  chatId: 'oc_1',
  chatType: 'p2p',
  senderOpenId: 'ou_sender',
  text: '帮我查一下昨天的 PV',
  mentions: [],
  mentionsAll: false,
  createTimeMs: 0,
  ...overrides,
});

const makeDeps = (overrides: Record<string, unknown> = {}) => {
  const card = {
    addProgress: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  };
  const sessions = {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    clear: vi.fn(),
  };
  const deps = {
    sessions,
    runAgent: vi.fn().mockResolvedValue({
      ok: true,
      text: '昨天 PV 是 12345',
      sessionId: 'sess_new',
    }),
    openCard: vi.fn().mockResolvedValue(card),
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
    logger: logger as never,
    ...overrides,
  };
  return { deps, card, sessions };
};

describe('createMessagePipeline', () => {
  it('收到消息先点 Typing 表情', async () => {
    const { deps } = makeDeps();
    await createMessagePipeline(deps as never)(msg());
    expect(deps.react).toHaveBeenCalledWith('om_1');
  });

  it('/new 清空会话并纯文本直答, 不启动模型', async () => {
    const { deps, sessions } = makeDeps();
    await createMessagePipeline(deps as never)(msg({ text: '/new' }));

    expect(sessions.clear).toHaveBeenCalledWith('p2p:ou_sender');
    expect(deps.reply).toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.openCard).not.toHaveBeenCalled();
  });

  it('私聊 /whoami 回显 open_id', async () => {
    const { deps } = makeDeps();
    await createMessagePipeline(deps as never)(msg({ text: '/whoami' }));

    expect(deps.reply.mock.calls[0][1]).toContain('ou_sender');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('群聊 /whoami 提示去私聊', async () => {
    const { deps } = makeDeps();
    await createMessagePipeline(deps as never)(
      msg({ text: '/whoami', chatType: 'group' }),
    );

    expect(deps.reply.mock.calls[0][1]).toContain('私聊');
    expect(deps.reply.mock.calls[0][1]).not.toContain('ou_sender');
  });

  it('固定直答走纯文本, 不启动模型', async () => {
    const { deps } = makeDeps();
    await createMessagePipeline(deps as never)(msg({ text: '你好' }));

    expect(deps.reply).toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('普通提问建卡 + 跑模型 + 终态 patch', async () => {
    const { deps, card } = makeDeps();
    await createMessagePipeline(deps as never)(msg());

    expect(deps.openCard).toHaveBeenCalledWith({
      chatId: 'oc_1',
      messageId: 'om_1',
      chatType: 'p2p',
    });
    expect(deps.runAgent.mock.calls[0][0]).toEqual({
      prompt: '帮我查一下昨天的 PV',
      resumeSessionId: undefined,
    });
    expect(card.finalize).toHaveBeenCalledWith('昨天 PV 是 12345');
  });

  it('有历史会话时带上 --resume 的 sessionId', async () => {
    const { deps, sessions } = makeDeps();
    sessions.get.mockReturnValue('sess_old');
    await createMessagePipeline(deps as never)(msg());

    expect(deps.runAgent.mock.calls[0][0].resumeSessionId).toBe('sess_old');
  });

  it('工具调用事件实时刷到卡片进度上', async () => {
    const { deps, card } = makeDeps({
      runAgent: vi.fn(async (_input: unknown, onEvent: (e: unknown) => void) => {
        onEvent({ type: 'tool', line: '📖 Read a.ts' });
        onEvent({ type: 'text', text: '中间输出' });
        return { ok: true, text: '答案', sessionId: 'sess_new' };
      }),
    });
    await createMessagePipeline(deps as never)(msg());

    expect(card.addProgress).toHaveBeenCalledWith('📖 Read a.ts');
    expect(card.addProgress).toHaveBeenCalledTimes(1);
  });

  it('成功后固化 sessionId', async () => {
    const { deps, sessions } = makeDeps();
    await createMessagePipeline(deps as never)(msg());
    expect(sessions.set).toHaveBeenCalledWith('p2p:ou_sender', 'sess_new');
  });

  it('模型返回失败时用红色卡片展示, 且不固化 sessionId', async () => {
    const { deps, card, sessions } = makeDeps({
      runAgent: vi.fn().mockResolvedValue({
        ok: false,
        text: '模型调用超时',
        sessionId: 'sess_new',
      }),
    });
    await createMessagePipeline(deps as never)(msg());

    expect(card.fail).toHaveBeenCalledWith('模型调用超时');
    expect(card.finalize).not.toHaveBeenCalled();
    expect(sessions.set).not.toHaveBeenCalled();
  });

  it('建卡失败时降级为纯文本回复, 仍然跑模型', async () => {
    const { deps } = makeDeps({
      openCard: vi.fn().mockRejectedValue(new Error('card rejected')),
    });
    await createMessagePipeline(deps as never)(msg());

    expect(deps.runAgent).toHaveBeenCalled();
    expect(deps.reply.mock.calls.at(-1)![1]).toBe('昨天 PV 是 12345');
  });

  it('runAgent 意外抛错转成用户可读的失败卡片, 不向上抛', async () => {
    const { deps, card } = makeDeps({
      runAgent: vi.fn().mockRejectedValue(new Error('unexpected')),
    });

    await expect(
      createMessagePipeline(deps as never)(msg()),
    ).resolves.toBeUndefined();
    expect(card.fail).toHaveBeenCalled();
    expect(card.fail.mock.calls[0][0]).toContain('出错');
  });

  it('点表情失败不影响正常流程', async () => {
    const { deps, card } = makeDeps({
      react: vi.fn().mockRejectedValue(new Error('no permission')),
    });

    await expect(
      createMessagePipeline(deps as never)(msg()),
    ).resolves.toBeUndefined();
    expect(card.finalize).toHaveBeenCalled();
  });
});
