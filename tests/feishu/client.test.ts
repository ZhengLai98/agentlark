import { describe, expect, it, vi } from 'vitest';
import { FeishuApiError, createFeishuApi } from '../../src/feishu/client';

const ok = (data: unknown) => ({ code: 0, msg: 'success', data });

describe('createFeishuApi', () => {
  it('sendMessage 走 POST /open-apis/im/v1/messages 并回传 message_id', async () => {
    const request = vi.fn().mockResolvedValue(ok({ message_id: 'om_new' }));
    const api = createFeishuApi({ request });

    const id = await api.sendMessage({
      chatId: 'oc_1',
      msgType: 'interactive',
      content: '{"schema":"2.0"}',
    });

    expect(id).toBe('om_new');
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_1',
        msg_type: 'interactive',
        content: '{"schema":"2.0"}',
      },
    });
  });

  it('replyMessage 走 reply 路径', async () => {
    const request = vi.fn().mockResolvedValue(ok({ message_id: 'om_reply' }));
    const api = createFeishuApi({ request });

    const id = await api.replyMessage({
      messageId: 'om_1',
      msgType: 'text',
      content: '{"text":"hi"}',
    });

    expect(id).toBe('om_reply');
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/open-apis/im/v1/messages/om_1/reply',
      data: { msg_type: 'text', content: '{"text":"hi"}' },
    });
  });

  it('patchMessage 走 PATCH 路径', async () => {
    const request = vi.fn().mockResolvedValue(ok({}));
    const api = createFeishuApi({ request });

    await api.patchMessage({ messageId: 'om_1', content: '{"schema":"2.0"}' });

    expect(request).toHaveBeenCalledWith({
      method: 'PATCH',
      url: '/open-apis/im/v1/messages/om_1',
      data: { content: '{"schema":"2.0"}' },
    });
  });

  it('createReaction 走 reactions 路径', async () => {
    const request = vi.fn().mockResolvedValue(ok({}));
    const api = createFeishuApi({ request });

    await api.createReaction({ messageId: 'om_1', emoji: 'Typing' });

    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/open-apis/im/v1/messages/om_1/reactions',
      data: { reaction_type: { emoji_type: 'Typing' } },
    });
  });

  it('getBotOpenId 从 bot/v3/info 取 open_id', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ code: 0, bot: { open_id: 'ou_bot' } });
    const api = createFeishuApi({ request });

    await expect(api.getBotOpenId()).resolves.toBe('ou_bot');
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
  });

  it('业务错误码转成带 code 的 FeishuApiError', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ code: 99991672, msg: 'no permission' });
    const api = createFeishuApi({ request });

    const failure = api.sendMessage({
      chatId: 'oc_1',
      msgType: 'text',
      content: '{}',
    });

    await expect(failure).rejects.toBeInstanceOf(FeishuApiError);
    await expect(failure).rejects.toMatchObject({ code: 99991672 });
  });

  it('兼容 SDK 已展平 data 的返回形态', async () => {
    const request = vi.fn().mockResolvedValue({ code: 0, message_id: 'om_flat' });
    const api = createFeishuApi({ request });

    await expect(
      api.sendMessage({ chatId: 'oc_1', msgType: 'text', content: '{}' }),
    ).resolves.toBe('om_flat');
  });

  it('响应里没有 message_id 时抛 FeishuApiError', async () => {
    const request = vi.fn().mockResolvedValue(ok({}));
    const api = createFeishuApi({ request });

    await expect(
      api.sendMessage({ chatId: 'oc_1', msgType: 'text', content: '{}' }),
    ).rejects.toBeInstanceOf(FeishuApiError);
  });
});
