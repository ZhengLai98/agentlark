/**
 * 子进程 env 白名单: 只透传模型跑起来必需的变量。
 * 白名单而非黑名单 —— 新增一个带密钥的 env 时不需要记得回来加屏蔽。
 */
export const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

export function buildChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
