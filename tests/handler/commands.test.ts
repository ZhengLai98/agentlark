import { describe, expect, it } from 'vitest';
import { matchCommand } from '../../src/handler/commands';

describe('matchCommand', () => {
  it('识别全部重置指令', () => {
    for (const text of ['/new', '/reset', '新对话', '重置']) {
      expect(matchCommand(text)).toEqual({ kind: 'reset' });
    }
  });

  it('识别 whoami 指令', () => {
    for (const text of ['/whoami', '/myid']) {
      expect(matchCommand(text)).toEqual({ kind: 'whoami' });
    }
  });

  it('识别固定直答并返回文案', () => {
    const hello = matchCommand('你好');
    expect(hello?.kind).toBe('canned');
    expect(hello && 'text' in hello ? hello.text.length : 0).toBeGreaterThan(0);

    expect(matchCommand('ping')?.kind).toBe('canned');
    expect(matchCommand('测试')?.kind).toBe('canned');
    expect(matchCommand('你是谁')?.kind).toBe('canned');
  });

  it('固定直答忽略大小写', () => {
    expect(matchCommand('PING')?.kind).toBe('canned');
  });

  it('只 trim 前后空白, 不做模糊匹配', () => {
    expect(matchCommand('  /new  ')).toEqual({ kind: 'reset' });
  });

  it('指令前后带其他文字时不匹配 (严格全匹配)', () => {
    expect(matchCommand('/new 顺便帮我查下部署状态')).toBeNull();
    expect(matchCommand('你好, 帮我看下这个报错')).toBeNull();
    expect(matchCommand('这个 ping 不通怎么办')).toBeNull();
  });

  it('普通问题不匹配', () => {
    expect(matchCommand('帮我查一下昨天的 PV')).toBeNull();
    expect(matchCommand('')).toBeNull();
  });
});
