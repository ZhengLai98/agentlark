export type CommandMatch =
  | { kind: 'reset' }
  | { kind: 'whoami' }
  | { kind: 'canned'; text: string };

export const RESET_REPLY = '已清空上下文, 下一条消息我们从头开始 🧹';

export const WHOAMI_GROUP_HINT =
  '群里拿到的是群 id, 不是你的 open_id。请私聊我再发一次 /whoami。';

const RESET_WORDS = new Set(['/new', '/reset', '新对话', '重置']);
const WHOAMI_WORDS = new Set(['/whoami', '/myid']);

/** 固定直答: 秒回, 不启动模型, 不占用会话。 */
const CANNED: Array<{ words: string[]; text: string }> = [
  {
    words: ['你好', '您好', 'hi', 'hello'],
    text: '你好 👋 我是 agentlark, 直接把问题发给我就行, 不用客气。',
  },
  {
    words: ['ping', '测试', 'test'],
    text: 'pong ✅ 服务在线。',
  },
  {
    words: ['你是谁', '你是什么'],
    text:
      '我是 agentlark — 你在飞书里的智能分身, 背后跑的是本机的 Claude Code。' +
      '直接提问即可; 想换个话题发 /new。',
  },
];

/**
 * 严格全匹配 (只 trim 前后空白): 指令前后带其他文字一律不匹配, 交给模型处理。
 * 匹配上的指令不启动模型, 后续计划里也不扣群聊额度。
 */
export function matchCommand(text: string): CommandMatch | null {
  const normalized = text.trim();
  if (normalized.length === 0) return null;

  const lowered = normalized.toLowerCase();

  if (RESET_WORDS.has(normalized) || RESET_WORDS.has(lowered)) {
    return { kind: 'reset' };
  }

  if (WHOAMI_WORDS.has(lowered)) {
    return { kind: 'whoami' };
  }

  for (const entry of CANNED) {
    if (entry.words.includes(normalized) || entry.words.includes(lowered)) {
      return { kind: 'canned', text: entry.text };
    }
  }

  return null;
}
