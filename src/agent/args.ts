export interface AgentArgsInput {
  /** 留空表示不传 --model, 由 ~/.claude/settings.json 决定。 */
  model: string;
  permissionMode: string;
  /** 有值则 --resume 续接既有会话。 */
  resumeSessionId?: string;
}

/**
 * 拼 claude 的 argv。prompt 刻意不进 argv —— 走 stdin,
 * 既绕开 argv 长度上限, 也避免用户正文里的引号/换行被 shell 语义污染。
 */
export function buildAgentArgs(input: AgentArgsInput): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    input.permissionMode,
  ];

  if (input.model) args.push('--model', input.model);
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);

  return args;
}
