import { describe, expect, it } from 'vitest';
import { MAX_CARD_MARKDOWN, toCardMarkdown } from '../../src/feishu/markdown';

describe('toCardMarkdown', () => {
  it('短文本原样返回', () => {
    expect(toCardMarkdown('部署完成 ✅')).toBe('部署完成 ✅');
  });

  it('去掉首尾空白', () => {
    expect(toCardMarkdown('\n\n答案\n\n')).toBe('答案');
  });

  it('空文本给出占位, 避免飞书拒收空卡片', () => {
    expect(toCardMarkdown('')).toBe('_(模型没有返回内容)_');
    expect(toCardMarkdown('   ')).toBe('_(模型没有返回内容)_');
  });

  it('超长文本截断到硬限内并带截断提示', () => {
    const out = toCardMarkdown('字'.repeat(MAX_CARD_MARKDOWN + 500));
    expect(out.length).toBeLessThanOrEqual(MAX_CARD_MARKDOWN);
    expect(out.endsWith('…(内容过长已截断)')).toBe(true);
  });

  it('刚好等于硬限的文本不截断', () => {
    const exact = '字'.repeat(MAX_CARD_MARKDOWN);
    expect(toCardMarkdown(exact)).toBe(exact);
  });
});
