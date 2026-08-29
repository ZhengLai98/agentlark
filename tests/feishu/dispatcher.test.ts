import { describe, expect, it, vi } from 'vitest';
import { handleMessageEvent } from '../../src/feishu/dispatcher';
import type { ParsedMessage } from '../../src/types/feishu';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const rawTextEvent = {
  sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
  message: {
    message_id: 'om_1',
    root_id: '',
    parent_id: '',
    create_time: '1700000000000',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '你好' }),
    mentions: [],
  },
};

describe('handleMessageEvent', () => {
  it('解析成功时把 ParsedMessage 交给 onMessage', () => {
    const seen: ParsedMessage[] = [];
    handleMessageEvent(rawTextEvent, logger as never, (m) => seen.push(m));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messageId).toBe('om_1');
  });

  it('不支持的类型静默丢弃, 不调 onMessage', () => {
    const onMessage = vi.fn();
    handleMessageEvent(
      {
        ...rawTextEvent,
        message: { ...rawTextEvent.message, message_type: 'file' },
      },
      logger as never,
      onMessage,
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('onMessage 抛错被吞掉, 不冒泡到 SDK 的事件循环', () => {
    expect(() =>
      handleMessageEvent(rawTextEvent, logger as never, () => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });
});
