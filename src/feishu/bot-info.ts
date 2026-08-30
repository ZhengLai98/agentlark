import type { Logger } from '../infra/logger';
import type { FeishuApi } from './client';

/**
 * 解析机器人自己的 open_id: env 配置优先, 否则调 bot/v3/info。
 * 该接口权限标注为「无」, 但要求「应用能力 → 机器人」已启用并发布。
 * 解析失败只告警不抛错 —— 启动不阻断, 代价是群聊 @ 检测失效 (filter 会全部丢弃)。
 */
export async function resolveBotOpenId(
  api: FeishuApi,
  configured: string,
  logger: Logger,
): Promise<string> {
  if (configured) return configured;

  try {
    const openId = await api.getBotOpenId();
    if (openId) {
      logger.info({ openId }, 'bot-info: bot open_id resolved');
      return openId;
    }
    logger.warn('bot-info: bot open_id unresolved (empty response)');
    return '';
  } catch (error) {
    logger.warn(
      { err: error },
      'bot-info: bot open_id unresolved; group @ detection disabled',
    );
    return '';
  }
}
