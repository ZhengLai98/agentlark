import type { Logger } from '../infra/logger';
import type { ParsedMessage } from '../types/feishu';
import type { FeishuApi } from './client';

export type Replier = (msg: ParsedMessage, text: string) => Promise<void>;

/**
 * 纯文本回复: 群聊引用原消息, 私聊直发。
 * 用于内置指令直答, 以及建卡失败时的降级路径。
 * 发送失败只记日志不抛错 —— 此时已经没有别的通道能告诉用户了。
 */
export function createReplier(api: FeishuApi, logger: Logger): Replier {
  return async (msg, text) => {
    const content = JSON.stringify({ text });
    try {
      if (msg.chatType === 'group') {
        await api.replyMessage({
          messageId: msg.messageId,
          msgType: 'text',
          content,
        });
      } else {
        await api.sendMessage({
          chatId: msg.chatId,
          msgType: 'text',
          content,
        });
      }
    } catch (error) {
      logger.error({ err: error, chatId: msg.chatId }, 'reply: send failed');
    }
  };
}
