import { z } from 'zod';

/** 把 "true"/"1" 之类的字符串 env 转成 boolean, 未设置或空串时用 fallback。 */
const boolEnv = (fallback: boolean) =>
  z.preprocess(
    (raw) =>
      raw === undefined || raw === ''
        ? fallback
        : raw === 'true' || raw === '1',
    z.boolean(),
  );

/** 未设置或空串时用 fallback 的数值 env。 */
const numEnv = (fallback: number, check: (schema: z.ZodNumber) => z.ZodNumber) =>
  z.preprocess(
    (raw) => (raw === undefined || raw === '' ? fallback : Number(raw)),
    check(z.number()),
  );

export const envSchema = z.object({
  FEISHU_APP_ID: z
    .string({ required_error: 'FEISHU_APP_ID is required' })
    .min(1, 'FEISHU_APP_ID is required'),
  FEISHU_APP_SECRET: z
    .string({ required_error: 'FEISHU_APP_SECRET is required' })
    .min(1, 'FEISHU_APP_SECRET is required'),
  FEISHU_BOT_OPEN_ID: z.string().default(''),

  AGENT_BIN: z.string().min(1).default('claude'),
  AGENT_MODEL: z.string().default(''),
  AGENT_TIMEOUT_MS: numEnv(120000, (s) => s.int().positive()),
  AGENT_PERMISSION_MODE: z
    .enum(['bypassPermissions', 'acceptEdits', 'default', 'plan'])
    .default('bypassPermissions'),
  AGENT_STREAM_THROTTLE_MS: numEnv(500, (s) => s.int().nonnegative()),

  IGNORE_AT_ALL: boolEnv(true),
  ALLOWED_GROUP_CHATS: z.string().default(''),
  ALLOWED_USERS: z.string().default(''),
  // 刻意没有默认值: 默认成 cwd 会把带 .env 的仓库根塞进 bypassPermissions 沙箱,
  // 详见 config/workspace.ts。必须由操作者显式指定一个独立目录。
  WORKSPACE_DIR: z
    .string({ required_error: 'WORKSPACE_DIR is required' })
    .min(1, 'WORKSPACE_DIR is required'),
  SESSION_MAX_IDLE_HOURS: numEnv(24, (s) => s.nonnegative()),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * 校验环境变量。缺必填项或取值非法时抛错 —— 调用方 (index.ts) 直接退出进程。
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues.map(
    (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
}

/** 逗号分隔列表 → 去空白去空项。 */
function parseCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 群白名单: 留空 = 允许全部群。 */
export function parseAllowedGroupChats(raw: string): string[] {
  return parseCsv(raw);
}

/** 发送人白名单 (open_id): 留空 = 允许全部人, 与群白名单口径一致。 */
export function parseAllowedUsers(raw: string): string[] {
  return parseCsv(raw);
}
