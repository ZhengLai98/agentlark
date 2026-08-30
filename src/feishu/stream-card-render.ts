import { MAX_CARD_MARKDOWN, toCardMarkdown } from './markdown';

/** 整张卡片 JSON 的硬限 (spec: 卡片 30KB)。 */
export const MAX_CARD_BYTES = 30_000;

const THINKING = '💭 思考中…';

export interface CardState {
  /** 工具调用进度行, 按发生顺序。 */
  progress: string[];
  /** 终态答案; 空串表示仍在思考。 */
  answer: string;
  /** 失败终态, 渲染红色标题。 */
  failed: boolean;
}

/**
 * 进度块同样是一个 markdown 元素, 一样受 3800 字硬限约束 —— 而 30KB 的字节闸门
 * 拦不住它: 一行 "🔧 Bash `...`" 约 54 字 / 56 字节, 150 行就是 8000+ 字 (两倍超限)
 * 却只有 8.5KB, 字节闸门一行都不会裁。超限的元素会被飞书拒收, 于是 patch 连续失败、
 * 续传的新卡同样超限, 答案彻底发不出去。所以这里按字符数从最早的行开始丢。
 */
function clampProgress(lines: string[]): { kept: string[]; dropped: number } {
  let length = 0;
  let start = lines.length;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = lines[i]!.length + (start === lines.length ? 0 : 1);
    if (length + cost > MAX_CARD_MARKDOWN) break;
    length += cost;
    start = i;
  }

  // 单行就超限时至少留最新的一行, 由 toCardMarkdown 截断; 元素不能是空串
  if (start === lines.length && lines.length > 0) start = lines.length - 1;

  return { kept: lines.slice(start), dropped: start };
}

function build(state: CardState, progress: string[]): object {
  const elements: object[] = [
    {
      tag: 'markdown',
      content: state.answer ? toCardMarkdown(state.answer) : THINKING,
    },
  ];

  if (progress.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: toCardMarkdown(progress.join('\n')) });
  }

  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'agentlark' },
      template: state.failed ? 'red' : 'blue',
    },
    body: { elements },
  };
}

/**
 * 纯函数: 状态 → 卡片 JSON。超过 30KB 时从最早的进度行开始裁,
 * 保证「最新进度 + 答案」永远留得下 (答案与进度块各自还受 3800 字的元素硬限收敛)。
 *
 * 用 Buffer.byteLength(..., 'utf8') 而不是 String.length: spec 的 30KB 是字节口径,
 * 而 .length 数的是 UTF-16 码元 —— 中文/emoji 一个字符占 3+ 字节却只算 1,
 * 用 .length 量会让闸门少算最多 3 倍, 卡片超限被飞书拒收后 patch 连续失败,
 * 续传的新卡同样超限, 内容彻底卡死。
 */
export function renderCard(state: CardState): {
  card: object;
  droppedProgress: number;
} {
  let lines = state.progress;
  let dropped = 0;

  for (;;) {
    const clamped = clampProgress(lines);
    const card = build(state, clamped.kept);
    dropped += clamped.dropped;

    if (
      clamped.kept.length === 0 ||
      Buffer.byteLength(JSON.stringify(card), 'utf8') <= MAX_CARD_BYTES
    ) {
      return { card, droppedProgress: dropped };
    }

    // 每轮至少裁一行, 行数多时按比例加速收敛
    const cut = Math.max(1, Math.floor(clamped.kept.length / 4));
    lines = clamped.kept.slice(cut);
    dropped += cut;
  }
}
