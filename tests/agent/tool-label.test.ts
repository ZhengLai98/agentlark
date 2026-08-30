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
    // 钉住确切输出而不是手算总长: 前缀里的 emoji 占 2 个 UTF-16 码元, 手算容易差一
    const line = formatToolLine('Bash', { command: 'x'.repeat(200) });
    expect(line).toBe(`🔧 Bash \`${'x'.repeat(60)}…\``);
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

  it('去掉命令里的反引号, 避免提前闭合卡片的 inline code', () => {
    expect(formatToolLine('Bash', { command: 'echo `date`' })).toBe(
      '🔧 Bash `echo date`',
    );
    expect(formatToolLine('Grep', { pattern: '`x`' })).toBe('🔍 Grep `x`');
  });
});
