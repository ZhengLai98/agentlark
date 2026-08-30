import { describe, expect, it } from 'vitest';
import { parseMessageEvent } from '../../src/feishu/parse';

const textEvent = (overrides: Record<string, unknown> = {}) => ({
  sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
  message: {
    message_id: 'om_1',
    root_id: '',
    parent_id: '',
    create_time: '1700000000000',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '帮我看下这个报错' }),
    mentions: [],
    ...overrides,
  },
});

describe('parseMessageEvent', () => {
  it('解析私聊纯文本消息', () => {
    const parsed = parseMessageEvent(textEvent());
    expect(parsed).toEqual({
      messageId: 'om_1',
      rootId: '',
      parentId: '',
      chatId: 'oc_1',
      chatType: 'p2p',
      senderOpenId: 'ou_sender',
      text: '帮我看下这个报错',
      mentions: [],
      mentionsAll: false,
      createTimeMs: 1700000000000,
    });
  });

  it('剥掉 @提及占位符并保留 mentions 明细', () => {
    const parsed = parseMessageEvent(
      textEvent({
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 这个接口怎么调' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'agentlark' },
        ],
      }),
    );
    expect(parsed?.text).toBe('这个接口怎么调');
    expect(parsed?.chatType).toBe('group');
    expect(parsed?.mentions).toEqual([
      { key: '@_user_1', openId: 'ou_bot', name: 'agentlark' },
    ]);
  });

  it('@_user_10 不会被 @_user_1 吃掉前缀', () => {
    const parsed = parseMessageEvent(
      textEvent({
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 @_user_10 帮我看下' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'agentlark' },
          { key: '@_user_10', id: { open_id: 'ou_tenth' }, name: '同事十' },
        ],
      }),
    );
    expect(parsed?.text).toBe('帮我看下');
  });

  it('识别 @全体成员', () => {
    const parsed = parseMessageEvent(
      textEvent({
        chat_type: 'group',
        content: JSON.stringify({ text: '@_all 服务挂了吗' }),
      }),
    );
    expect(parsed?.mentionsAll).toBe(true);
    expect(parsed?.text).toBe('服务挂了吗');
  });

  it('保留换行, 只合并多余的空格', () => {
    const parsed = parseMessageEvent(
      textEvent({ content: JSON.stringify({ text: 'a   b\n\nc' }) }),
    );
    expect(parsed?.text).toBe('a b\n\nc');
  });

  it('只 @不说话时正文为空字符串', () => {
    const parsed = parseMessageEvent(
      textEvent({
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 ' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'agentlark' },
        ],
      }),
    );
    expect(parsed?.text).toBe('');
  });

  it('非 text 类型返回 null (静默忽略)', () => {
    for (const type of ['image', 'post', 'file', 'audio', 'media']) {
      expect(parseMessageEvent(textEvent({ message_type: type }))).toBeNull();
    }
  });

  it('content 不是合法 JSON 时返回 null', () => {
    expect(parseMessageEvent(textEvent({ content: 'not-json' }))).toBeNull();
  });

  it('缺关键字段时返回 null', () => {
    expect(parseMessageEvent({})).toBeNull();
    expect(parseMessageEvent(null)).toBeNull();
    expect(
      parseMessageEvent({ message: { message_id: 'om_1' } }),
    ).toBeNull();
  });

  it('未知 chat_type 返回 null', () => {
    expect(parseMessageEvent(textEvent({ chat_type: 'topic' }))).toBeNull();
  });
});
