import { describe, expect, it } from 'vitest';
import { MAX_CARD_MARKDOWN } from '../../src/feishu/markdown';
import {
  MAX_CARD_BYTES,
  renderCard,
} from '../../src/feishu/stream-card-render';

const progressElement = (card: any): string =>
  card.body.elements.filter((e: any) => e.tag === 'markdown').at(-1)!.content;

describe('renderCard', () => {
  it('没有答案时渲染「思考中」', () => {
    const { card } = renderCard({ progress: [], answer: '', failed: false });
    expect(JSON.stringify(card)).toContain('💭 思考中');
  });

  it('卡片使用 schema 2.0 并允许多次更新', () => {
    const { card } = renderCard({ progress: [], answer: '', failed: false }) as {
      card: any;
    };
    expect(card.schema).toBe('2.0');
    expect(card.config.update_multi).toBe(true);
  });

  it('有答案时答案取代「思考中」', () => {
    const { card } = renderCard({
      progress: ['📖 Read a.ts'],
      answer: '这是答案',
      failed: false,
    });
    const json = JSON.stringify(card);
    expect(json).toContain('这是答案');
    expect(json).not.toContain('💭 思考中');
  });

  it('进度行渲染在分隔线之后', () => {
    const { card } = renderCard({
      progress: ['📖 Read a.ts', '🔧 Bash npm test'],
      answer: '',
      failed: false,
    }) as { card: any };
    expect(card.body.elements.some((e: any) => e.tag === 'hr')).toBe(true);
    expect(JSON.stringify(card)).toContain('🔧 Bash npm test');
  });

  it('没有进度行时不渲染分隔线', () => {
    const { card } = renderCard({
      progress: [],
      answer: '答案',
      failed: false,
    }) as { card: any };
    expect(card.body.elements.some((e: any) => e.tag === 'hr')).toBe(false);
  });

  it('进度行超量时裁掉最早的几行, 并报告裁掉了几行 (卡片仍在 30KB 内)', () => {
    const progress = Array.from({ length: 400 }, (_, i) =>
      `🔧 Bash ${'x'.repeat(100)} <${String(i).padStart(3, '0')}>`,
    );
    const { card, droppedProgress } = renderCard({
      progress,
      answer: '',
      failed: false,
    });

    expect(
      Buffer.byteLength(JSON.stringify(card), 'utf8'),
    ).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(droppedProgress).toBeGreaterThan(0);
    expect(JSON.stringify(card)).toContain('<399>');
    expect(JSON.stringify(card)).not.toContain('<000>');
  });

  it('答案本身超限时靠 markdown 硬限收敛, 仍不超 30KB', () => {
    const { card } = renderCard({
      progress: [],
      answer: '字'.repeat(50000),
      failed: false,
    });
    expect(
      Buffer.byteLength(JSON.stringify(card), 'utf8'),
    ).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });

  it('按 UTF-8 字节而不是字符数裁剪 (中文一个字 3 字节)', () => {
    // 12000 行 × 每行 4 个中文字: 字符数远低于 30000, 字节数远超
    const progress = Array.from({ length: 12000 }, (_, i) => `🔧 执行中 ${i}`);
    const { card, droppedProgress } = renderCard({
      progress,
      answer: '',
      failed: false,
    });

    const json = JSON.stringify(card);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(droppedProgress).toBeGreaterThan(0);
    // 守住回归: 若用 .length 量, 这张卡会被判为“未超限”而不裁
    expect(json.length).toBeLessThan(MAX_CARD_BYTES);
  });

  it('进度块自身不超过 markdown 元素的 3800 字硬限', () => {
    // 200 行真实形态的工具调用行: ~11000 字, 但只有 ~11KB, 30KB 字节闸门一行都不会裁
    const progress = Array.from(
      { length: 200 },
      (_, i) => `🔧 Bash \`npm run test -- --run tests/some/path/file-${i}.test.ts\``,
    );
    const { card } = renderCard({
      progress,
      answer: '',
      failed: false,
    }) as { card: any };

    const content = progressElement(card);
    expect(content.length).toBeLessThanOrEqual(MAX_CARD_MARKDOWN);
    // 裁的是最早的行, 最新进度必须留下
    expect(content).toContain('file-199.test.ts');
    expect(content).not.toContain('file-0.test.ts');
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(
      MAX_CARD_BYTES,
    );
  });

  it('单行就超限时至少留最新一行的截断版, 元素不为空', () => {
    const { card } = renderCard({
      progress: ['🔧 ' + 'x'.repeat(MAX_CARD_MARKDOWN * 2)],
      answer: '',
      failed: false,
    }) as { card: any };

    const content = progressElement(card);
    expect(content.length).toBeGreaterThan(0);
    expect(content.length).toBeLessThanOrEqual(MAX_CARD_MARKDOWN);
  });

  it('failed 状态渲染红色标题', () => {
    const { card } = renderCard({
      progress: [],
      answer: '调用超时了',
      failed: true,
    }) as { card: any };
    expect(card.header.template).toBe('red');
  });
});
