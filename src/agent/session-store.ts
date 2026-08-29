import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ParsedMessage } from '../types/feishu';

/** spec 规定的落点; 注意与 runtime/ 是两个不同目录, 不要合并。 */
export const SESSIONS_FILE = resolve(
  process.cwd(),
  'user-data/runtime/sessions.json',
);

/** 会话维度: 私聊按人, 群聊按群。 */
export function sessionKey(msg: ParsedMessage): string {
  return msg.chatType === 'p2p'
    ? `p2p:${msg.senderOpenId}`
    : `group:${msg.chatId}`;
}

interface SessionRecord {
  sessionId: string;
  updatedAt: number;
}

export interface SessionStore {
  /** 返回可用于 --resume 的 sessionId; 不存在或已过期返回 undefined。 */
  get(key: string): string | undefined;
  set(key: string, sessionId: string): void;
  clear(key: string): void;
}

const isRecord = (value: unknown): value is SessionRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as SessionRecord).sessionId === 'string' &&
  typeof (value as SessionRecord).updatedAt === 'number';

function load(file: string): Map<string, SessionRecord> {
  const map = new Map<string, SessionRecord>();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return map;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return map;
    for (const [key, value] of Object.entries(parsed)) {
      if (isRecord(value)) map.set(key, value);
    }
  } catch {
    // 文件损坏时当作空的重新开始; 代价只是丢一轮上下文
  }
  return map;
}

/** 原子写: 先写临时文件再 rename, 避免崩在半截留下坏文件。 */
function persist(file: string, map: Map<string, SessionRecord>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
  renameSync(tmp, file);
}

export function createSessionStore(opts: {
  file: string;
  /** 0 表示不过期。 */
  maxIdleHours: number;
  now?: () => number;
}): SessionStore {
  const now = opts.now ?? (() => Date.now());
  const map = load(opts.file);
  const maxIdleMs = opts.maxIdleHours * 3600_000;

  return {
    get(key) {
      const record = map.get(key);
      if (!record) return undefined;

      if (maxIdleMs > 0 && now() - record.updatedAt > maxIdleMs) {
        map.delete(key);
        persist(opts.file, map);
        return undefined;
      }
      return record.sessionId;
    },

    set(key, sessionId) {
      if (!sessionId) return;
      map.set(key, { sessionId, updatedAt: now() });
      persist(opts.file, map);
    },

    clear(key) {
      if (map.delete(key)) persist(opts.file, map);
    },
  };
}
