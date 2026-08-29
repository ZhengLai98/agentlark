import { describe, expect, it, vi } from 'vitest';
import { createReplier } from '../../src/feishu/reply';
import type { ParsedMessage } from '../../src/types/feishu';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const msg = (chatType: 'p2p' | 'group'): ParsedMessage => ({
  messageId: 'om_1',
  rootId: '',
  parentId: '',
  chatId: 'oc_1',
  chatType,
  senderOpenId: 'ou_sender',
  text: 'hi',
  mentions: [],
  mentionsAll: false,
  createTimeMs: 0,
});

describe('createReplier', () => {
  it('群聊引用原消息回复', async () => {
    const api = {
      replyMessage: vi.fn().mockResolvedValue('om_reply'),
      sendMessage: vi.fn(),
    };
    await createReplier(api as never, logger as never)(msg('group'), '答案');

    expect(api.replyMessage).toHaveBeenCalledWith({
      messageId: 'om_1',
      msgType: 'text',
      content: JSON.stringify({ text: '答案' }),
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('私聊直发不引用', async () => {
    const api = {
      replyMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue('om_new'),
    };
    await createReplier(api as never, logger as never)(msg('p2p'), '答案');

    expect(api.sendMessage).toHaveBeenCalledWith({
      chatId: 'oc_1',
      msgType: 'text',
      content: JSON.stringify({ text: '答案' }),
    });
    expect(api.replyMessage).not.toHaveBeenCalled();
  });

  it('发送失败只记日志不抛错 (回复是尽力而为)', async () => {
    const error = vi.fn();
    const api = {
      replyMessage: vi.fn(),
      sendMessage: vi.fn().mockRejectedValue(new Error('boom')),
    };
    await expect(
      createReplier(api as never, { ...logger, error } as never)(msg('p2p'), 'x'),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
