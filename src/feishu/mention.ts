import type { ParsedMessage } from '../types/feishu';

/**
 * 是否 @了本机器人。botOpenId 为空 (bot/v3/info 解析失败) 时一律返回 false,
 * 表现为群聊不触发 —— 宁可不响应, 也不要在群里对每条消息作答。
 */
export function isBotMentioned(msg: ParsedMessage, botOpenId: string): boolean {
  if (!botOpenId) return false;
  return msg.mentions.some((mention) => mention.openId === botOpenId);
}
