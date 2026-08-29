import { describe, expect, it } from 'vitest';
import { BoundedSet } from '../../src/infra/bounded-set';
import { filterMessage } from '../../src/handler/filter';
import type { ParsedMessage } from '../../src/types/feishu';

const msg = (overrides: Partial<ParsedMessage> = {}): ParsedMessage => ({
  messageId: 'om_1',
  rootId: '',
  parentId: '',
  chatId: 'oc_1',
  chatType: 'p2p',
  senderOpenId: 'ou_sender',
  text: '你好啊',
  mentions: [],
  mentionsAll: false,
  createTimeMs: 1700000000000,
  ...overrides,
});

const opts = (overrides: Partial<Parameters<typeof filterMessage>[1]> = {}) => ({
  botOpenId: 'ou_bot',
  ignoreAtAll: true,
  allowedGroupChats: [] as string[],
  seen: new BoundedSet(100),
  ...overrides,
});

const atBot = { key: '@_user_1', openId: 'ou_bot', name: 'agentlark' };

describe('filterMessage', () => {
  it('私聊有正文直接放行', () => {
    expect(filterMessage(msg(), opts())).toEqual({ action: 'process' });
  });

  it('重复 message_id 被去重丢弃', () => {
    const shared = opts();
    expect(filterMessage(msg(), shared)).toEqual({ action: 'process' });
    expect(filterMessage(msg(), shared)).toEqual({
      action: 'drop',
      reason: 'duplicate',
    });
  });

  it('机器人自己发的消息丢弃', () => {
    expect(filterMessage(msg({ senderOpenId: 'ou_bot' }), opts())).toEqual({
      action: 'drop',
      reason: 'self',
    });
  });

  it('群白名单留空时允许全部群', () => {
    const m = msg({ chatType: 'group', mentions: [atBot] });
    expect(filterMessage(m, opts())).toEqual({ action: 'process' });
  });

  it('群不在白名单内被丢弃', () => {
    const m = msg({ chatType: 'group', mentions: [atBot] });
    expect(filterMessage(m, opts({ allowedGroupChats: ['oc_other'] }))).toEqual({
      action: 'drop',
      reason: 'group-not-allowed',
    });
  });

  it('白名单只对群聊生效, 私聊不受限', () => {
    expect(filterMessage(msg(), opts({ allowedGroupChats: ['oc_other'] }))).toEqual(
      { action: 'process' },
    );
  });

  it('默认忽略 @全体成员', () => {
    const m = msg({ chatType: 'group', mentionsAll: true, mentions: [atBot] });
    expect(filterMessage(m, opts())).toEqual({ action: 'drop', reason: 'at-all' });
  });

  it('IGNORE_AT_ALL=false 时 @全体成员照常处理', () => {
    const m = msg({ chatType: 'group', mentionsAll: true, mentions: [atBot] });
    expect(filterMessage(m, opts({ ignoreAtAll: false }))).toEqual({
      action: 'process',
    });
  });

  it('群聊没 @机器人不触发', () => {
    const m = msg({ chatType: 'group', mentions: [] });
    expect(filterMessage(m, opts())).toEqual({
      action: 'drop',
      reason: 'not-mentioned',
    });
  });

  it('bot open_id 未解析出来时群聊一律不触发', () => {
    const m = msg({ chatType: 'group', mentions: [atBot] });
    expect(filterMessage(m, opts({ botOpenId: '' }))).toEqual({
      action: 'drop',
      reason: 'not-mentioned',
    });
  });

  it('只 @不说话不触发', () => {
    const m = msg({ chatType: 'group', text: '', mentions: [atBot] });
    expect(filterMessage(m, opts())).toEqual({ action: 'drop', reason: 'empty' });
  });

  it('私聊空白消息不触发', () => {
    expect(filterMessage(msg({ text: '   ' }), opts())).toEqual({
      action: 'drop',
      reason: 'empty',
    });
  });
});
