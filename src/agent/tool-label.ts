const MAX_DETAIL = 60;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/**
 * 压平换行、去掉反引号并截断, 保证进度行不破坏卡片 markdown 结构。
 *
 * 反引号必须去掉: 进度行把命令包在 `...` 里, 命令自带反引号会把这段 inline code
 * 提前闭合, 卡片上显示成一截乱码 —— `echo \`date\`` 这种老式命令替换很常见。
 * 进度行是给人扫一眼用的, 不是可复制执行的命令, 丢掉反引号可以接受。
 */
function clip(text: string): string {
  const flat = text.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat;
}

const basename = (path: string): string =>
  path.split('/').filter(Boolean).pop() ?? path;

/** tool_use → 卡片上的一行进度, 如 "📖 Read app.ts"。 */
export function formatToolLine(name: string, input: unknown): string {
  const fields = asRecord(input);

  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const file = str(fields.file_path);
      return file ? `📖 ${name} ${basename(file)}` : `⚙️ ${name}`;
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = str(fields.file_path);
      return file ? `✏️ ${name} ${basename(file)}` : `⚙️ ${name}`;
    }
    case 'Bash': {
      const command = str(fields.command);
      return command ? `🔧 ${name} \`${clip(command)}\`` : `⚙️ ${name}`;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(fields.pattern);
      return pattern ? `🔍 ${name} \`${clip(pattern)}\`` : `⚙️ ${name}`;
    }
    case 'WebFetch':
    case 'WebSearch': {
      const detail = str(fields.url) || str(fields.query);
      return detail ? `🌐 ${name} ${clip(detail)}` : `⚙️ ${name}`;
    }
    case 'Task': {
      const description = str(fields.description);
      return description ? `🤖 ${name} ${clip(description)}` : `⚙️ ${name}`;
    }
    default:
      return `⚙️ ${name}`;
  }
}
