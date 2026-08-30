import { describe, expect, it } from 'vitest';
import { BoundedSet } from '../../src/infra/bounded-set';

describe('BoundedSet', () => {
  it('首次添加返回 true, 重复添加返回 false', () => {
    const set = new BoundedSet(10);
    expect(set.add('a')).toBe(true);
    expect(set.add('a')).toBe(false);
  });

  it('超出容量时淘汰最早插入的 key', () => {
    const set = new BoundedSet(2);
    set.add('a');
    set.add('b');
    set.add('c');
    expect(set.size).toBe(2);
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
  });

  it('容量内不淘汰', () => {
    const set = new BoundedSet(3);
    set.add('a');
    set.add('b');
    expect(set.has('a')).toBe(true);
    expect(set.size).toBe(2);
  });
});
