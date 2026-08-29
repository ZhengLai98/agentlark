import { toCardMarkdown } from './markdown';

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

function build(state: CardState, progress: string[]): object {
  const elements: object[] = [
    {
      tag: 'markdown',
      content: state.answer ? toCardMarkdown(state.answer) : THINKING,
    },
  ];

  if (progress.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: progress.join('\n') });
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
 * 保证「最新进度 + 答案」永远留得下 (答案本身由 markdown 硬限收敛)。
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
  let progress = state.progress;
  let card = build(state, progress);
  let dropped = 0;

  while (
    Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_CARD_BYTES &&
    progress.length > 0
  ) {
    // 每轮至少裁一行, 行数多时按比例加速收敛
    const cut = Math.max(1, Math.floor(progress.length / 4));
    progress = progress.slice(cut);
    dropped += cut;
    card = build(state, progress);
  }

  return { card, droppedProgress: dropped };
}
