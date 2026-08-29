import type { ChatType, MentionRef, ParsedMessage } from '../types/feishu';

/** 飞书 @全体成员在正文里的占位符。 */
const AT_ALL_KEY = '@_all';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

function readMentions(raw: unknown): MentionRef[] {
  if (!Array.isArray(raw)) return [];
  const result: MentionRef[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const key = asString(record.key);
    const openId = asString(asRecord(record.id)?.open_id);
    if (!key || !openId) continue;
    result.push({ key, openId, name: asString(record.name) });
  }
  return result;
}

/** 去掉 @占位符, 合并多余空格但保留换行 (代码块/多段问题要留结构)。 */
function stripMentions(text: string, mentions: MentionRef[]): string {
  let out = text;
  for (const mention of mentions) out = out.split(mention.key).join('');
  out = out.split(AT_ALL_KEY).join('');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 原始 im.message.receive_v1 事件 → ParsedMessage。
 * 返回 null 表示静默忽略 (不支持的消息类型 / 结构不完整), 调用方不得回复用户。
 * Plan 1 只支持 text; image / post / 引用消息在 Plan 2 接入。
 */
export function parseMessageEvent(event: unknown): ParsedMessage | null {
  const root = asRecord(event);
  if (!root) return null;

  const message = asRecord(root.message);
  if (!message) return null;

  if (asString(message.message_type) !== 'text') return null;

  const messageId = asString(message.message_id);
  const chatId = asString(message.chat_id);
  if (!messageId || !chatId) return null;

  const chatTypeRaw = asString(message.chat_type);
  if (chatTypeRaw !== 'p2p' && chatTypeRaw !== 'group') return null;
  const chatType: ChatType = chatTypeRaw;

  const senderOpenId = asString(
    asRecord(asRecord(root.sender)?.sender_id)?.open_id,
  );
  if (!senderOpenId) return null;

  let rawText: string;
  try {
    const content = JSON.parse(asString(message.content));
    rawText = asString(asRecord(content)?.text);
  } catch {
    return null;
  }

  const mentions = readMentions(message.mentions);

  return {
    messageId,
    rootId: asString(message.root_id),
    parentId: asString(message.parent_id),
    chatId,
    chatType,
    senderOpenId,
    text: stripMentions(rawText, mentions),
    mentions,
    mentionsAll: rawText.includes(AT_ALL_KEY),
    createTimeMs: Number(asString(message.create_time)) || 0,
  };
}
