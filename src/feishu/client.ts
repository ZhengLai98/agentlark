import * as Lark from '@larksuiteoapi/node-sdk';

export type MsgType = 'text' | 'interactive';

/** SDK 的裸 HTTP 逃生口; 只依赖这一个方法, 不绑定 SDK 的资源方法名。 */
export interface LarkRequester {
  request<T = any>(payload: {
    method: string;
    url: string;
    data?: unknown;
    params?: unknown;
  }): Promise<T>;
}

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly api: string,
  ) {
    super(message);
    this.name = 'FeishuApiError';
  }
}

export interface FeishuApi {
  /** 主动发消息, 返回新消息的 message_id。 */
  sendMessage(input: {
    chatId: string;
    msgType: MsgType;
    content: string;
  }): Promise<string>;
  /** 引用回复某条消息, 返回新消息的 message_id。 */
  replyMessage(input: {
    messageId: string;
    msgType: MsgType;
    content: string;
  }): Promise<string>;
  /** 更新已发出的卡片。 */
  patchMessage(input: { messageId: string; content: string }): Promise<void>;
  createReaction(input: { messageId: string; emoji: string }): Promise<void>;
  getBotOpenId(): Promise<string>;
}

export function createLarkClient(
  appId: string,
  appSecret: string,
): LarkRequester {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  }) as unknown as LarkRequester;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

/** SDK 有时展平 data, 有时保留 { code, data } 信封, 两种都吃。 */
function unwrap(response: unknown, api: string): Record<string, unknown> {
  const body = asRecord(response);
  const code = typeof body.code === 'number' ? body.code : 0;
  if (code !== 0) {
    const msg = typeof body.msg === 'string' ? body.msg : 'unknown error';
    throw new FeishuApiError(`${api} failed: ${msg} (code=${code})`, code, api);
  }
  return 'data' in body ? asRecord(body.data) : body;
}

function readMessageId(payload: Record<string, unknown>, api: string): string {
  const id = payload.message_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new FeishuApiError(`${api} returned no message_id`, 0, api);
  }
  return id;
}

export function createFeishuApi(requester: LarkRequester): FeishuApi {
  return {
    async sendMessage({ chatId, msgType, content }) {
      const response = await requester.request({
        method: 'POST',
        url: '/open-apis/im/v1/messages',
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content },
      });
      return readMessageId(unwrap(response, 'im.message.create'), 'im.message.create');
    },

    async replyMessage({ messageId, msgType, content }) {
      const response = await requester.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${messageId}/reply`,
        data: { msg_type: msgType, content },
      });
      return readMessageId(unwrap(response, 'im.message.reply'), 'im.message.reply');
    },

    async patchMessage({ messageId, content }) {
      const response = await requester.request({
        method: 'PATCH',
        url: `/open-apis/im/v1/messages/${messageId}`,
        data: { content },
      });
      unwrap(response, 'im.message.patch');
    },

    async createReaction({ messageId, emoji }) {
      const response = await requester.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${messageId}/reactions`,
        data: { reaction_type: { emoji_type: emoji } },
      });
      unwrap(response, 'im.messageReaction.create');
    },

    async getBotOpenId() {
      const response = await requester.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      const payload = unwrap(response, 'bot.v3.info');
      const openId = asRecord(payload.bot).open_id;
      return typeof openId === 'string' ? openId : '';
    },
  };
}
