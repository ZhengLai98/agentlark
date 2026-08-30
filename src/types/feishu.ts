export type ChatType = 'p2p' | 'group';

export interface MentionRef {
  /** 正文里的占位符, 形如 "@_user_1"。 */
  key: string;
  openId: string;
  name: string;
}

/** 归一化后的消息, 下游 filter / commands / message 只认这个结构。 */
export interface ParsedMessage {
  messageId: string;
  rootId: string;
  parentId: string;
  chatId: string;
  chatType: ChatType;
  senderOpenId: string;
  /** 已剥掉 @占位符并 trim 过的正文。 */
  text: string;
  mentions: MentionRef[];
  mentionsAll: boolean;
  createTimeMs: number;
}
