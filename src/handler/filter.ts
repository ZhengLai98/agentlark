import { isBotMentioned } from '../feishu/mention';
import type { ParsedMessage } from '../types/feishu';

export type DropReason =
  | 'duplicate'
  | 'self'
  | 'user-not-allowed'
  | 'group-not-allowed'
  | 'at-all'
  | 'not-mentioned'
  | 'empty';

export type FilterDecision =
  | { action: 'process' }
  | { action: 'drop'; reason: DropReason };

export interface FilterOptions {
  botOpenId: string;
  ignoreAtAll: boolean;
  /** 留空 = 允许全部群。 */
  allowedGroupChats: string[];
  /** 发送人 open_id 白名单; 留空 = 允许全部人。私聊与群聊都生效。 */
  allowedUsers: string[];
  /** message_id 去重集合; add 返回 true 表示首次出现。 */
  seen: { add(key: string): boolean };
}

/**
 * 纯函数: 决定一条消息该不该进主流水线。
 * 顺序与 spec 的数据流一致: 去重 → self → 人白名单 → 群白名单 → @all → 群须 @bot → 空文本。
 * 人白名单紧跟在 self 之后, 因此私聊与群聊同样受限 —— Plan 3 的审批闸门落地前,
 * 它是唯一能挡住「租户里任何人都能拿到本机 bypassPermissions shell」的开关。
 * 被丢弃的消息一律不回复用户 (静默)。
 */
export function filterMessage(
  msg: ParsedMessage,
  opts: FilterOptions,
): FilterDecision {
  if (!opts.seen.add(msg.messageId)) {
    return { action: 'drop', reason: 'duplicate' };
  }

  if (opts.botOpenId && msg.senderOpenId === opts.botOpenId) {
    return { action: 'drop', reason: 'self' };
  }

  if (
    opts.allowedUsers.length > 0 &&
    !opts.allowedUsers.includes(msg.senderOpenId)
  ) {
    return { action: 'drop', reason: 'user-not-allowed' };
  }

  if (msg.chatType === 'group') {
    if (
      opts.allowedGroupChats.length > 0 &&
      !opts.allowedGroupChats.includes(msg.chatId)
    ) {
      return { action: 'drop', reason: 'group-not-allowed' };
    }

    if (msg.mentionsAll && opts.ignoreAtAll) {
      return { action: 'drop', reason: 'at-all' };
    }

    if (!isBotMentioned(msg, opts.botOpenId)) {
      return { action: 'drop', reason: 'not-mentioned' };
    }
  }

  if (msg.text.trim().length === 0) {
    return { action: 'drop', reason: 'empty' };
  }

  return { action: 'process' };
}
