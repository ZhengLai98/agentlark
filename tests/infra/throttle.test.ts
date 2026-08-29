import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottle } from '../../src/infra/throttle';

describe('createThrottle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('间隔内的多次 push 只触发一次 sink, 且取最后一个值', async () => {
    const seen: string[] = [];
    const throttled = createThrottle<string>(500, async (v) => {
      seen.push(v);
    });

    throttled.push('a');
    throttled.push('b');
    throttled.push('c');
    expect(seen).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual(['c']);
  });

  it('flush 立即冲刷待发值并等待 sink 完成', async () => {
    const seen: string[] = [];
    const throttled = createThrottle<string>(500, async (v) => {
      seen.push(v);
    });

    throttled.push('a');
    await throttled.flush();
    expect(seen).toEqual(['a']);
  });

  it('没有待发值时 flush 不触发 sink', async () => {
    const sink = vi.fn(async () => {});
    const throttled = createThrottle<string>(500, sink);
    await throttled.flush();
    expect(sink).not.toHaveBeenCalled();
  });

  it('sink 抛错不会冒泡, 后续 push 仍然生效', async () => {
    const seen: string[] = [];
    const throttled = createThrottle<string>(500, async (v) => {
      if (v === 'bad') throw new Error('boom');
      seen.push(v);
    });

    throttled.push('bad');
    await vi.advanceTimersByTimeAsync(500);
    throttled.push('good');
    await vi.advanceTimersByTimeAsync(500);
    await throttled.flush();

    expect(seen).toEqual(['good']);
  });
});
