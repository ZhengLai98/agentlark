export interface Throttled<T> {
  /** 覆盖式提交待发值; 距上次触发不足 intervalMs 时合并。 */
  push(value: T): void;
  /** 立即冲刷待发值, 并等待所有已排队的 sink 调用结束。 */
  flush(): Promise<void>;
}

/**
 * 尾沿节流: push 后至多 intervalMs 触发一次 sink, 取该窗口内最后一个值。
 * sink 之间严格串行 (卡片 patch 不能乱序), sink 抛错只吞不冒泡。
 */
export function createThrottle<T>(
  intervalMs: number,
  sink: (value: T) => Promise<void>,
): Throttled<T> {
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const emit = (): void => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    chain = chain.then(() => sink(value)).catch(() => undefined);
  };

  return {
    push(value: T): void {
      pending = { value };
      if (timer === null) timer = setTimeout(emit, intervalMs);
    },
    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      emit();
      await chain;
    },
  };
}
