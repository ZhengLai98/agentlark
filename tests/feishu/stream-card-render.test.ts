import { describe, expect, it } from 'vitest';
import {
  MAX_CARD_BYTES,
  renderCard,
} from '../../src/feishu/stream-card-render';

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

  it('超过 30KB 时裁掉最早的进度行, 并报告裁掉了几行', () => {
    const progress = Array.from({ length: 400 }, (_, i) =>
      `🔧 Bash ${'x'.repeat(100)} <${String(i).padStart(3, '0')}>`,
    );
    const { card, droppedProgress } = renderCard({
      progress,
      answer: '',
      failed: false,
    });

    expect(JSON.stringify(card).length).toBeLessThanOrEqual(MAX_CARD_BYTES);
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
    expect(JSON.stringify(card).length).toBeLessThanOrEqual(MAX_CARD_BYTES);
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
