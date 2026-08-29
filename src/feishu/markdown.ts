/** 单个 markdown 元素的正文硬限 (spec: markdown 3800 字)。 */
export const MAX_CARD_MARKDOWN = 3800;

const TRUNCATED_SUFFIX = '…(内容过长已截断)';
const EMPTY_PLACEHOLDER = '_(模型没有返回内容)_';

/** 归一化模型输出, 保证落进卡片 markdown 元素时不空、不超限。 */
export function toCardMarkdown(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return EMPTY_PLACEHOLDER;
  if (trimmed.length <= MAX_CARD_MARKDOWN) return trimmed;

  const keep = MAX_CARD_MARKDOWN - TRUNCATED_SUFFIX.length;
  return trimmed.slice(0, keep) + TRUNCATED_SUFFIX;
}
