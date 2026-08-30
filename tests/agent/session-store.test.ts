import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSessionStore,
  sessionKey,
} from '../../src/agent/session-store';
import type { ParsedMessage } from '../../src/types/feishu';

const tmpFile = () =>
  join(mkdtempSync(join(tmpdir(), 'agentlark-')), 'sessions.json');

const msg = (overrides: Partial<ParsedMessage>): ParsedMessage => ({
  messageId: 'om_1',
  rootId: '',
  parentId: '',
  chatId: 'oc_1',
  chatType: 'p2p',
  senderOpenId: 'ou_sender',
  text: 'hi',
  mentions: [],
  mentionsAll: false,
  createTimeMs: 0,
  ...overrides,
});

const HOUR = 3600_000;

describe('sessionKey', () => {
  it('私聊按发送人隔离', () => {
    expect(sessionKey(msg({ chatType: 'p2p' }))).toBe('p2p:ou_sender');
  });

  it('群聊按群隔离 (同群成员共享上下文)', () => {
    expect(sessionKey(msg({ chatType: 'group' }))).toBe('group:oc_1');
  });
});

describe('createSessionStore', () => {
  it('文件不存在时从空开始', () => {
    const store = createSessionStore({ file: tmpFile(), maxIdleHours: 24 });
    expect(store.get('p2p:a')).toBeUndefined();
  });

  it('set 之后能读回来', () => {
    const store = createSessionStore({ file: tmpFile(), maxIdleHours: 24 });
    store.set('p2p:a', 'sess_1');
    expect(store.get('p2p:a')).toBe('sess_1');
  });

  it('落盘后新实例能恢复 (重启不丢)', () => {
    const file = tmpFile();
    createSessionStore({ file, maxIdleHours: 24 }).set('p2p:a', 'sess_1');
    expect(
      createSessionStore({ file, maxIdleHours: 24 }).get('p2p:a'),
    ).toBe('sess_1');
  });

  it('clear 之后读不到', () => {
    const store = createSessionStore({ file: tmpFile(), maxIdleHours: 24 });
    store.set('p2p:a', 'sess_1');
    store.clear('p2p:a');
    expect(store.get('p2p:a')).toBeUndefined();
  });

  it('空闲超过 maxIdleHours 的会话读不到', () => {
    let clock = 0;
    const store = createSessionStore({
      file: tmpFile(),
      maxIdleHours: 24,
      now: () => clock,
    });
    store.set('p2p:a', 'sess_1');

    clock = 23 * HOUR;
    expect(store.get('p2p:a')).toBe('sess_1');

    clock = 25 * HOUR;
    expect(store.get('p2p:a')).toBeUndefined();
  });

  it('过期条目会从落盘文件里清掉', () => {
    const file = tmpFile();
    let clock = 0;
    const store = createSessionStore({ file, maxIdleHours: 24, now: () => clock });
    store.set('p2p:a', 'sess_1');

    clock = 25 * HOUR;
    store.get('p2p:a');

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });

  it('每次 set 刷新空闲计时', () => {
    let clock = 0;
    const store = createSessionStore({
      file: tmpFile(),
      maxIdleHours: 24,
      now: () => clock,
    });
    store.set('p2p:a', 'sess_1');

    clock = 20 * HOUR;
    store.set('p2p:a', 'sess_1');

    clock = 35 * HOUR;
    expect(store.get('p2p:a')).toBe('sess_1');
  });

  it('maxIdleHours=0 表示不过期', () => {
    let clock = 0;
    const store = createSessionStore({
      file: tmpFile(),
      maxIdleHours: 0,
      now: () => clock,
    });
    store.set('p2p:a', 'sess_1');
    clock = 1000 * HOUR;
    expect(store.get('p2p:a')).toBe('sess_1');
  });

  it('文件内容损坏时从空开始, 不崩', () => {
    const file = tmpFile();
    writeFileSync(file, 'not json at all');
    const store = createSessionStore({ file, maxIdleHours: 24 });
    expect(store.get('p2p:a')).toBeUndefined();
    store.set('p2p:a', 'sess_1');
    expect(store.get('p2p:a')).toBe('sess_1');
  });
});
