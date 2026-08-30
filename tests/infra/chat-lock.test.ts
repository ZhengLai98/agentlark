import { describe, expect, it } from 'vitest';
import { ChatLock } from '../../src/infra/chat-lock';

const defer = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ChatLock', () => {
  it('同一 key 的任务串行执行', async () => {
    const lock = new ChatLock();
    const order: string[] = [];

    const first = lock.run('chat', async () => {
      order.push('first:start');
      await defer(20);
      order.push('first:end');
    });
    const second = lock.run('chat', async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await Promise.all([first, second]);
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('不同 key 并发执行', async () => {
    const lock = new ChatLock();
    const order: string[] = [];

    await Promise.all([
      lock.run('a', async () => {
        await defer(20);
        order.push('a');
      }),
      lock.run('b', async () => {
        order.push('b');
      }),
    ]);

    expect(order).toEqual(['b', 'a']);
  });

  it('前一个任务失败不阻塞后一个', async () => {
    const lock = new ChatLock();
    const failed = lock.run('chat', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');

    await expect(lock.run('chat', async () => 'ok')).resolves.toBe('ok');
  });

  it('把任务的返回值透传给调用方', async () => {
    const lock = new ChatLock();
    await expect(lock.run('chat', async () => 42)).resolves.toBe(42);
  });
});
