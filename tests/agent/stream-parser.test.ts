import { describe, expect, it } from 'vitest';
import { createStreamParser } from '../../src/agent/stream-parser';
import type { AgentEvent } from '../../src/types/agent';

const collect = () => {
  const events: AgentEvent[] = [];
  const parser = createStreamParser((e) => events.push(e));
  return { events, parser };
};

describe('createStreamParser', () => {
  it('从 system.init 行取出 session_id', () => {
    const { events, parser } = collect();
    parser.write(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_a' }) +
        '\n',
    );
    expect(events).toEqual([{ type: 'session', sessionId: 'sess_a' }]);
  });

  it('把 tool_use 转成进度行', () => {
    const { events, parser } = collect();
    parser.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } },
          ],
        },
      }) + '\n',
    );
    expect(events).toEqual([{ type: 'tool', line: '📖 Read b.ts' }]);
  });

  it('把 assistant 文本块转成 text 事件', () => {
    const { events, parser } = collect();
    parser.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '正在看代码' }] },
      }) + '\n',
    );
    expect(events).toEqual([{ type: 'text', text: '正在看代码' }]);
  });

  it('一行内的多个 content 块按顺序展开', () => {
    const { events, parser } = collect();
    parser.write(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '先读文件' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }) + '\n',
    );
    expect(events).toEqual([
      { type: 'text', text: '先读文件' },
      { type: 'tool', line: '🔧 Bash `ls`' },
    ]);
  });

  it('result 行给出终态答案与 session_id', () => {
    const { events, parser } = collect();
    parser.write(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '最终答案',
        session_id: 'sess_a',
      }) + '\n',
    );
    expect(events).toEqual([
      { type: 'result', ok: true, text: '最终答案', sessionId: 'sess_a' },
    ]);
  });

  it('is_error=true 时 result.ok 为 false', () => {
    const { events, parser } = collect();
    parser.write(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: '出错了',
        session_id: 'sess_a',
      }) + '\n',
    );
    expect(events).toEqual([
      { type: 'result', ok: false, text: '出错了', sessionId: 'sess_a' },
    ]);
  });

  it('跨 chunk 切断的 JSON 行能拼回来', () => {
    const { events, parser } = collect();
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess_split',
    });
    parser.write(line.slice(0, 10));
    parser.write(line.slice(10) + '\n');
    expect(events).toEqual([{ type: 'session', sessionId: 'sess_split' }]);
  });

  it('end() 冲刷没有结尾换行的最后一行', () => {
    const { events, parser } = collect();
    parser.write(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_z' }),
    );
    expect(events).toEqual([]);
    parser.end();
    expect(events).toEqual([{ type: 'session', sessionId: 'sess_z' }]);
  });

  it('非 JSON 行与未知事件类型被忽略, 不抛错', () => {
    const { events, parser } = collect();
    parser.write('not json\n');
    parser.write('\n');
    parser.write(JSON.stringify({ type: 'brand_new_event' }) + '\n');
    parser.write(JSON.stringify({ type: 'user', message: {} }) + '\n');
    parser.end();
    expect(events).toEqual([]);
  });

  it('回调抛错不会打断后续解析', () => {
    const seen: string[] = [];
    const parser = createStreamParser((e) => {
      if (e.type === 'session') throw new Error('boom');
      if (e.type === 'text') seen.push(e.text);
    });
    parser.write(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }) + '\n',
    );
    parser.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }) + '\n',
    );
    expect(seen).toEqual(['ok']);
  });
});
