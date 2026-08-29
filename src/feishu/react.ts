import type { Logger } from '../infra/logger';
import type { FeishuApi } from './client';

/** 收到可处理消息后先点一个 Typing 表情, 让用户知道已收到。失败无害, 只记日志。 */
export async function reactTyping(
  api: FeishuApi,
  messageId: string,
  logger: Logger,
): Promise<void> {
  try {
    await api.createReaction({ messageId, emoji: 'Typing' });
  } catch (error) {
    logger.debug({ err: error, messageId }, 'react: typing reaction failed');
  }
}
