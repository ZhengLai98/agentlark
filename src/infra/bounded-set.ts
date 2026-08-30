/**
 * 固定容量的插入序集合, 超容淘汰最早插入项。
 * 用于 message_id 去重 (容量 1 万), 防止 WS 重投导致重复消费。
 */
export class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly maxSize: number) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** 首次出现返回 true; 已存在返回 false。 */
  add(key: string): boolean {
    if (this.items.has(key)) return false;
    this.items.add(key);
    while (this.items.size > this.maxSize) {
      const oldest = this.items.values().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.items.size;
  }
}
