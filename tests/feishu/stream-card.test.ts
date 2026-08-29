import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStreamCard } from '../../src/feishu/stream-card';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const target = {
  chatId: 'oc_1',
  messageId: 'om_1',
  chatType: 'group' as const,
};

const makeApi = () => ({
  sendMessage: vi.fn().mockResolvedValue('om_card_send'),
  replyMessage: vi.fn().mockResolvedValue('om_card_reply'),
  patchMessage: vi.fn().mockResolvedValue(undefined),
  createReaction: vi.fn(),
  getBotOpenId: vi.fn(),
});

describe('openStreamCard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('群聊用引用回复建卡, 首帧是思考中', async () => {
    const api = makeApi();
    await openStreamCard({ api, logger: logger as never, throttleMs: 500 }, target);

    expect(api.replyMessage).toHaveBeenCalledTimes(1);
    const arg = api.replyMessage.mock.calls[0][0];
    expect(arg.msgType).toBe('interactive');
    expect(arg.content).toContain('💭 思考中');
  });

  it('私聊用直发建卡', async () => {
    const api = makeApi();
    await openStreamCard({ api, logger: logger as never, throttleMs: 500 }, {
      ...target,
      chatType: 'p2p',
    });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.replyMessage).not.toHaveBeenCalled();
  });

  it('进度行按节流合并成一次 patch', async () => {
    const api = makeApi();
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    card.addProgress('📖 Read a.ts');
    card.addProgress('🔧 Bash npm test');
    expect(api.patchMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(api.patchMessage).toHaveBeenCalledTimes(1);
    expect(api.patchMessage.mock.calls[0][0].content).toContain('🔧 Bash npm test');
  });

  it('finalize 立即冲刷并 patch 成终态答案', async () => {
    const api = makeApi();
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    card.addProgress('📖 Read a.ts');
    await card.finalize('这是最终答案');

    const last = api.patchMessage.mock.calls.at(-1)![0];
    expect(last.messageId).toBe('om_card_reply');
    expect(last.content).toContain('这是最终答案');
    expect(last.content).not.toContain('💭 思考中');
  });

  it('finalize 后再 addProgress 不再发请求', async () => {
    const api = makeApi();
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    await card.finalize('done');
    const count = api.patchMessage.mock.calls.length;

    card.addProgress('📖 Read late.ts');
    await vi.advanceTimersByTimeAsync(500);
    expect(api.patchMessage).toHaveBeenCalledTimes(count);
  });

  it('patch 连续 3 次失败后发新卡片续传, 内容不丢', async () => {
    const api = makeApi();
    api.patchMessage.mockRejectedValue(new Error('230099'));
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    for (let i = 0; i < 3; i += 1) {
      card.addProgress(`🔧 step ${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }

    // 第 3 次失败后补发新卡片
    expect(api.replyMessage).toHaveBeenCalledTimes(2);
    expect(api.replyMessage.mock.calls[1][0].content).toContain('🔧 step 2');
  });

  it('patch 成功会重置失败计数', async () => {
    const api = makeApi();
    api.patchMessage
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'));
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    for (let i = 0; i < 4; i += 1) {
      card.addProgress(`🔧 step ${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(api.replyMessage).toHaveBeenCalledTimes(1);
  });

  it('fail 渲染红色终态卡片', async () => {
    const api = makeApi();
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    await card.fail('调用超时了');
    const last = api.patchMessage.mock.calls.at(-1)![0];
    expect(last.content).toContain('调用超时了');
    expect(last.content).toContain('"red"');
  });

  it('建卡失败时把错误抛给调用方 (由调用方降级为纯文本)', async () => {
    const api = makeApi();
    api.replyMessage.mockRejectedValue(new Error('card rejected'));

    await expect(
      openStreamCard({ api, logger: logger as never, throttleMs: 500 }, target),
    ).rejects.toThrow('card rejected');
  });
});
