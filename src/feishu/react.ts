import type { Logger } from '../infra/logger';
import type { FeishuApi } from './client';

/**
 * 收到可处理消息后先点一个 Typing 表情, 让用户知道已收到。失败无害, 只记日志。
 * 记 warn 而不是 debug: 失败几乎都是缺 im:message.reaction 之类的权限,
 * 默认 LOG_LEVEL=info 下记 debug 等于操作者永远不知道这个能力是坏的。
 */
export async function reactTyping(
  api: FeishuApi,
  messageId: string,
  logger: Logger,
): Promise<void> {
  try {
    await api.createReaction({ messageId, emoji: 'Typing' });
  } catch (error) {
    logger.warn({ err: error, messageId }, 'react: typing reaction failed');
  }
}
