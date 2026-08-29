import { describe, expect, it } from 'vitest';
import { formatToolLine } from '../../src/agent/tool-label';

describe('formatToolLine', () => {
  it('Read 显示文件名而不是全路径', () => {
    expect(formatToolLine('Read', { file_path: '/repo/src/app.ts' })).toBe(
      '📖 Read app.ts',
    );
  });

  it('Bash 显示命令', () => {
    expect(formatToolLine('Bash', { command: 'npm test' })).toBe(
      '🔧 Bash `npm test`',
    );
  });

  it('Bash 长命令截断到 60 字符', () => {
    const line = formatToolLine('Bash', { command: 'x'.repeat(200) });
    expect(line.length).toBeLessThanOrEqual(70);
    expect(line).toContain('…');
  });

  it('Grep / Glob 显示 pattern', () => {
    expect(formatToolLine('Grep', { pattern: 'TODO' })).toBe('🔍 Grep `TODO`');
    expect(formatToolLine('Glob', { pattern: '**/*.ts' })).toBe(
      '🔍 Glob `**/*.ts`',
    );
  });

  it('写类工具用铅笔图标', () => {
    expect(formatToolLine('Edit', { file_path: '/repo/a.ts' })).toBe(
      '✏️ Edit a.ts',
    );
    expect(formatToolLine('Write', { file_path: '/repo/b.ts' })).toBe(
      '✏️ Write b.ts',
    );
  });

  it('WebFetch 显示 URL', () => {
    expect(formatToolLine('WebFetch', { url: 'https://example.com' })).toBe(
      '🌐 WebFetch https://example.com',
    );
  });

  it('Task 显示描述', () => {
    expect(formatToolLine('Task', { description: '排查构建失败' })).toBe(
      '🤖 Task 排查构建失败',
    );
  });

  it('未知工具只显示名字', () => {
    expect(formatToolLine('SomeMcpTool', { whatever: 1 })).toBe('⚙️ SomeMcpTool');
  });

  it('input 缺字段时只显示名字, 不抛错', () => {
    expect(formatToolLine('Read', {})).toBe('⚙️ Read');
    expect(formatToolLine('Bash', null)).toBe('⚙️ Bash');
  });

  it('换行被压平, 不破坏卡片 markdown', () => {
    expect(formatToolLine('Bash', { command: 'a\nb' })).toBe('🔧 Bash `a b`');
  });
});
