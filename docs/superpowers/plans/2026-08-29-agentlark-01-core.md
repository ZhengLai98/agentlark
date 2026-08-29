# agentlark Plan 1: 核心问答闭环 (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书用户（私聊直接发、群聊 @机器人）能提问，机器人拉起本机 `claude` headless 子进程流式作答，并以飞书卡片实时更新工具调用进度、最终 patch 成完整回复，会话上下文按会话维度持久化续接。

**Architecture:** TypeScript ESM + `tsx` 直跑不构建。`@larksuiteoapi/node-sdk` 的 WebSocket 长连接接收 `im.message.receive_v1` 事件 → 纯函数 `parse` / `filter` / `commands` 决定要不要处理 → `ChatLock` 保证同会话串行 → `agent/stream-runner` spawn `claude` 并按 NDJSON 解析 `stream-json` 输出 → `feishu/stream-card` 节流刷新卡片。所有 IO（飞书 API、spawn、落盘）都以接口形式依赖注入进 `handler/message.ts`，测试注入 mock，`src/index.ts` 是唯一装配点、不写业务。

**Tech Stack:** Node.js ≥ 20 / TypeScript ESM / tsx / @larksuiteoapi/node-sdk / zod / pino / vitest / eslint

**Spec:** `docs/spec/agentlark-spec.md`（本仓库内已归档的飞书原文档快照）

**本计划在 4 份计划中的位置：**

| 计划 | 范围 | 状态 |
|-|-|-|
| **Plan 1（本文档）** | 核心问答闭环：env 校验 / WS 接入 / 解析过滤 / 内置指令 / spawn claude / 流式卡片 / 会话持久化 | 现在执行 |
| Plan 2 | 上下文与内容：多仓库 `--add-dir` 挂载 / Wiki 同步与缓存 / prompt 构造策略 / 图片·富文本·引用消息 / 输出脱敏 / 群聊限额 | 未写 |
| Plan 3 | 审批闸门：PreToolUse hook / 审批服务 / 四级分流 / 意图卡与授权 / 风险体检 / 改动汇总 / 临时白名单 | 未写 |
| Plan 4 | 运维加固：pid 单实例 / launchd / 健康探针 / 防休眠 / 运维脚本 / 排错文档 | 未写 |

**明确不在 Plan 1 范围内**（不要顺手实现，会与后续计划冲突）：图片/富文本/引用消息解析、Wiki 同步、多仓库挂载、prompt 系统头、输出脱敏、群聊额度、审批闸门、pid 文件、launchd、健康探针。Plan 1 的 prompt 就是用户原话本身。

---

## Global Constraints

以下取值逐条抄自 spec，所有任务的要求都隐含包含本节。

- **运行时**：Node.js ≥ 20，TypeScript ESM，`tsx` 直跑不构建（不产出 `dist/`，没有 build 脚本）。
- **飞书接入**：`@larksuiteoapi/node-sdk` **WebSocket 长连接**（无需公网 IP），Plan 1 只订阅 `im.message.receive_v1`（`card.action.trigger` 属于 Plan 3）。
- **模型执行**：spawn 本机 `claude` CLI（headless，`stream-json` 输出），子进程 env 走白名单收敛（`src/agent/child-env.ts`）。
- **配置**：`.env` + zod schema 校验（`src/config/env.ts`），**缺必填项启动即退出**。
- **日志/测试**：pino / vitest + eslint + tsc。
- **分层纪律**：`src/index.ts` 只做 wire 不写业务；`handler/message.ts` 只做编排，所有 IO（reply / spawn / 落盘）依赖注入，测试注入 mock；`filter` / `commands` / `parse` / `stream-parser` / `stream-card-render` 是纯函数叶子模块。
- **错误语义**：任何子步骤抛错都转为用户可读消息回复，不向上抛；`uncaughtException` 记 fatal 后退出（进程管理属 Plan 4，Plan 1 只记 fatal 并 `process.exit(1)`）。
- **运行时目录**（spec 原样，两个目录刻意不同，不要合并）：
  - `user-data/runtime/sessions.json` — chat → sessionId 映射，重启不丢
  - `runtime/logs/bot.log` — 日志
- **默认值**（逐条抄自 spec 配置项表）：`AGENT_BIN=claude`、`AGENT_MODEL=`（空，留空由 `~/.claude/settings.json` 决定）、`AGENT_TIMEOUT_MS=120000`、`AGENT_PERMISSION_MODE=bypassPermissions`、`AGENT_STREAM_THROTTLE_MS=500`、`IGNORE_AT_ALL=true`、`WORKSPACE_DIR=cwd`、`ALLOWED_GROUP_CHATS=`（**留空 = 允许全部群**）、`SESSION_MAX_IDLE_HOURS=24`、`LOG_LEVEL=info`。
- **仓库挂载 env 约定**（Plan 1 只在 `.env.example` 里写注释占位，实现在 Plan 2）：`REPO_PATHS=<别名>:<绝对路径>,<别名>:<绝对路径>,...`，**数量不限**，留空则跳过挂载。不要沿用 spec 里 `REPO_PATHS_*` 的 5 个固定键。
- **卡片硬限**：卡片 JSON 30KB、markdown 正文 3800 字；超出裁最早的进度行；patch **连续 3 次**失败发新卡片续传。
- **消息去重**：`message_id` 进程内 LRU，容量 **1 万**。
- **不支持的消息类型静默忽略**，不回复、不报错（Plan 1 里除 `text` 外全部静默忽略）。
- **内置指令严格全匹配**（前后不能带其他文字），不启动模型。

---

## File Structure

```
agentlark/
├── package.json                    # scripts: start/dev/typecheck/lint/test
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── .gitignore
├── .env.example
├── docs/spec/agentlark-spec.md     # 已存在: 飞书原文档快照
├── docs/superpowers/plans/         # 已存在: 本计划
└── src/
    ├── index.ts                    # 唯一装配点: 读 env → wire → 启动 WS dispatcher
    ├── config/env.ts               # zod schema + loadEnv() + parseAllowedGroupChats()
    ├── infra/
    │   ├── logger.ts               # pino, 同时写 stdout 与 runtime/logs/bot.log
    │   ├── bounded-set.ts          # LRU 去重集合
    │   ├── chat-lock.ts            # 按 key 串行的任务队列
    │   └── throttle.ts             # 尾沿节流, 用于卡片刷新
    ├── types/
    │   ├── feishu.ts               # ParsedMessage / MentionRef / ChatType
    │   └── agent.ts                # AgentEvent / AgentResult / RunAgent
    ├── feishu/
    │   ├── client.ts               # Lark client + FeishuApi 薄封装(裸 HTTP, 不依赖 SDK 具体方法名)
    │   ├── bot-info.ts             # 解析 bot open_id (env 优先, 否则 bot/v3/info)
    │   ├── parse.ts                # 纯函数: 原始事件 → ParsedMessage | null
    │   ├── mention.ts              # 纯函数: 是否 @了 bot
    │   ├── markdown.ts             # 纯函数: 卡片 markdown 长度硬限与截断
    │   ├── reply.ts                # 纯文本回复(群聊引用原消息, 私聊直发)
    │   ├── react.ts                # 收到消息点 Typing 表情回执
    │   ├── stream-card-render.ts   # 纯函数: 卡片 JSON 构建 + 30KB 裁剪
    │   ├── stream-card.ts          # 有状态卡片句柄: 建卡/节流 patch/终态/失败续传
    │   └── dispatcher.ts           # WSClient + EventDispatcher
    ├── agent/
    │   ├── args.ts                 # 纯函数: 拼 claude argv
    │   ├── child-env.ts            # 纯函数: 子进程 env 白名单
    │   ├── tool-label.ts           # 纯函数: tool_use → "📖 Read foo.ts" 进度行
    │   ├── stream-parser.ts        # 纯函数: NDJSON stream-json → AgentEvent
    │   ├── stream-runner.ts        # spawn claude, 超时, 事件回调
    │   └── session-store.ts        # sessions.json 落盘 + 24h 空闲过期 + sessionKey()
    └── handler/
        ├── filter.ts               # 纯函数: 去重/白名单/@all/群须@bot/空文本
        ├── commands.ts             # 纯函数: /new /whoami 固定直答
        └── message.ts              # 编排层: 全部 IO 依赖注入
```

测试镜像 `src/` 结构放在 `tests/`，如 `tests/handler/filter.test.ts`。

---

### Task 1: 项目脚手架与环境配置校验

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.env.example`, `src/config/env.ts`
- Test: `tests/config/env.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `loadEnv(source?: NodeJS.ProcessEnv): Env`、`type Env`、`parseAllowedGroupChats(raw: string): string[]`

- [ ] **Step 1: 初始化仓库与 npm 工程**

在 `/Users/zhengdianshuang/myProject/agentlark` 下执行（`docs/` 已存在，不要删）：

```bash
cd /Users/zhengdianshuang/myProject/agentlark
git init
npm init -y
npm pkg set name=agentlark version=0.1.0 private=true type=module
npm pkg set engines.node=">=20"
npm pkg set scripts.start="tsx src/index.ts"
npm pkg set scripts.dev="tsx watch src/index.ts"
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.lint="eslint ."
npm pkg set scripts.test="vitest"
npm pkg delete scripts.build 2>/dev/null || true
npm install @larksuiteoapi/node-sdk dotenv pino "zod@^3"
npm install -D typescript tsx vitest eslint @eslint/js typescript-eslint @types/node
```

`zod` 固定在 `^3`：本计划所有 schema 代码按 zod 3 的 API 编写。

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noImplicitOverride": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "tests"]
}
```

`moduleResolution: bundler` 让 import 可以不写 `.js` 后缀，`tsx` 运行时能解析。

- [ ] **Step 3: 写 vitest.config.ts 与 eslint.config.js**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

`eslint.config.js`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'runtime/**', 'user-data/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
```

- [ ] **Step 4: 写 .gitignore**

```gitignore
node_modules/
runtime/
user-data/
.env
.DS_Store
coverage/
*.log
```

- [ ] **Step 5: 写 tests/config/env.test.ts（失败的测试）**

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv, parseAllowedGroupChats } from '../../src/config/env';

const base = {
  FEISHU_APP_ID: 'cli_test',
  FEISHU_APP_SECRET: 'secret_test',
};

describe('loadEnv', () => {
  it('缺少 FEISHU_APP_SECRET 时抛出可读错误', () => {
    expect(() => loadEnv({ FEISHU_APP_ID: 'cli_test' })).toThrowError(
      /FEISHU_APP_SECRET/,
    );
  });

  it('缺少 FEISHU_APP_ID 时抛出可读错误', () => {
    expect(() => loadEnv({ FEISHU_APP_SECRET: 'secret_test' })).toThrowError(
      /FEISHU_APP_ID/,
    );
  });

  it('只填必填项时套用 spec 规定的默认值', () => {
    const env = loadEnv({ ...base });
    expect(env.AGENT_BIN).toBe('claude');
    expect(env.AGENT_MODEL).toBe('');
    expect(env.AGENT_TIMEOUT_MS).toBe(120000);
    expect(env.AGENT_PERMISSION_MODE).toBe('bypassPermissions');
    expect(env.AGENT_STREAM_THROTTLE_MS).toBe(500);
    expect(env.IGNORE_AT_ALL).toBe(true);
    expect(env.SESSION_MAX_IDLE_HOURS).toBe(24);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.ALLOWED_GROUP_CHATS).toBe('');
    expect(env.WORKSPACE_DIR).toBe(process.cwd());
  });

  it('数值型 env 从字符串转换', () => {
    const env = loadEnv({ ...base, AGENT_TIMEOUT_MS: '5000' });
    expect(env.AGENT_TIMEOUT_MS).toBe(5000);
  });

  it('IGNORE_AT_ALL=false 关闭忽略', () => {
    expect(loadEnv({ ...base, IGNORE_AT_ALL: 'false' }).IGNORE_AT_ALL).toBe(false);
  });

  it('拒绝非法的 AGENT_TIMEOUT_MS', () => {
    expect(() => loadEnv({ ...base, AGENT_TIMEOUT_MS: '-1' })).toThrowError(
      /AGENT_TIMEOUT_MS/,
    );
  });
});

describe('parseAllowedGroupChats', () => {
  it('留空表示允许全部群', () => {
    expect(parseAllowedGroupChats('')).toEqual([]);
    expect(parseAllowedGroupChats('  ')).toEqual([]);
  });

  it('按逗号切分并去掉空白项', () => {
    expect(parseAllowedGroupChats('oc_a, oc_b ,, oc_c')).toEqual([
      'oc_a',
      'oc_b',
      'oc_c',
    ]);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/config/env.test.ts`
Expected: FAIL，报错 `Failed to resolve import "../../src/config/env"`

- [ ] **Step 7: 写 src/config/env.ts**

```ts
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
  WORKSPACE_DIR: z.string().min(1).default(process.cwd()),
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

/** 群白名单: 留空 = 允许全部群。 */
export function parseAllowedGroupChats(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run tests/config/env.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 9: 写 .env.example**

```dotenv
# ---- 飞书应用 (必填) ----
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=

# 留空则启动时自动调 bot/v3/info 解析; 拿不到则群聊 @ 检测失效
FEISHU_BOT_OPEN_ID=

# ---- 模型子进程 ----
# claude 可执行文件路径; launchd 托管时 PATH 不含 ~/.local/bin, 建议写绝对路径
AGENT_BIN=claude
# 留空由 ~/.claude/settings.json 决定
AGENT_MODEL=
# 单次调用超时 (ms)
AGENT_TIMEOUT_MS=120000
# 模型权限模式; 真正的闸门是审批 hook (Plan 3), 现在等于完全写权限
AGENT_PERMISSION_MODE=bypassPermissions
# 流式卡片刷新节流 (ms)
AGENT_STREAM_THROTTLE_MS=500
# 模型子进程工作目录, 留空 = 本进程 cwd
WORKSPACE_DIR=

# ---- 消息接入 ----
# 忽略 @全体成员
IGNORE_AT_ALL=true
# 群白名单, 逗号分隔; 留空 = 允许全部群
ALLOWED_GROUP_CHATS=

# ---- 会话 ----
# 会话空闲超时 (小时), 0 = 不限
SESSION_MAX_IDLE_HOURS=24

# ---- 日志 ----
LOG_LEVEL=info

# ---- 以下为后续计划占位, Plan 1 未读取 ----
# 挂载给模型的代码仓库, 数量不限: 别名:绝对路径, 逗号分隔; 留空跳过挂载 (Plan 2)
# REPO_PATHS=web-main:/Users/you/repos/web-main,mobile-app:/Users/you/repos/mobile-app
```

- [ ] **Step 10: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 两条命令都退出码 0，无输出错误

- [ ] **Step 11: 提交**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.js .gitignore .env.example src/config/env.ts tests/config/env.test.ts docs
git commit -m "feat: 项目脚手架与 zod 环境变量校验"
```

---

### Task 2: 基础设施叶子模块（日志 / LRU 去重 / 会话锁 / 节流）

**Files:**
- Create: `src/infra/logger.ts`, `src/infra/bounded-set.ts`, `src/infra/chat-lock.ts`, `src/infra/throttle.ts`
- Test: `tests/infra/bounded-set.test.ts`, `tests/infra/chat-lock.test.ts`, `tests/infra/throttle.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `createLogger(level: string): pino.Logger`、`LOG_FILE: string`
  - `class BoundedSet { constructor(maxSize: number); add(key: string): boolean; has(key: string): boolean; get size(): number }`（`add` 返回 `true` 表示首次出现）
  - `class ChatLock { run<T>(key: string, task: () => Promise<T>): Promise<T> }`
  - `createThrottle<T>(intervalMs: number, sink: (value: T) => Promise<void>): { push(value: T): void; flush(): Promise<void> }`

- [ ] **Step 1: 写 tests/infra/bounded-set.test.ts（失败的测试）**

```ts
import { describe, expect, it } from 'vitest';
import { BoundedSet } from '../../src/infra/bounded-set';

describe('BoundedSet', () => {
  it('首次添加返回 true, 重复添加返回 false', () => {
    const set = new BoundedSet(10);
    expect(set.add('a')).toBe(true);
    expect(set.add('a')).toBe(false);
  });

  it('超出容量时淘汰最早插入的 key', () => {
    const set = new BoundedSet(2);
    set.add('a');
    set.add('b');
    set.add('c');
    expect(set.size).toBe(2);
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
  });

  it('容量内不淘汰', () => {
    const set = new BoundedSet(3);
    set.add('a');
    set.add('b');
    expect(set.has('a')).toBe(true);
    expect(set.size).toBe(2);
  });
});
```

- [ ] **Step 2: 写 tests/infra/chat-lock.test.ts（失败的测试）**

```ts
import { describe, expect, it } from 'vitest';
import { ChatLock } from '../../src/infra/chat-lock';

const defer = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ChatLock', () => {
  it('同一 key 的任务串行执行', async () => {
    const lock = new ChatLock();
    const order: string[] = [];

    const first = lock.run('chat', async () => {
      order.push('first:start');
      await defer(20);
      order.push('first:end');
    });
    const second = lock.run('chat', async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await Promise.all([first, second]);
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('不同 key 并发执行', async () => {
    const lock = new ChatLock();
    const order: string[] = [];

    await Promise.all([
      lock.run('a', async () => {
        await defer(20);
        order.push('a');
      }),
      lock.run('b', async () => {
        order.push('b');
      }),
    ]);

    expect(order).toEqual(['b', 'a']);
  });

  it('前一个任务失败不阻塞后一个', async () => {
    const lock = new ChatLock();
    const failed = lock.run('chat', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');

    await expect(lock.run('chat', async () => 'ok')).resolves.toBe('ok');
  });

  it('把任务的返回值透传给调用方', async () => {
    const lock = new ChatLock();
    await expect(lock.run('chat', async () => 42)).resolves.toBe(42);
  });
});
```

- [ ] **Step 3: 写 tests/infra/throttle.test.ts（失败的测试）**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottle } from '../../src/infra/throttle';

describe('createThrottle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('间隔内的多次 push 只触发一次 sink, 且取最后一个值', async () => {
    const seen: string[] = [];
    const throttled = createThrottle<string>(500, async (v) => {
      seen.push(v);
    });

    throttled.push('a');
    throttled.push('b');
    throttled.push('c');
    expect(seen).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual(['c']);
  });

  it('flush 立即冲刷待发值并等待 sink 完成', async () => {
    const seen: string[] = [];
    const throttled = createThrottle<string>(500, async (v) => {
      seen.push(v);
    });

    throttled.push('a');
    await throttled.flush();
    expect(seen).toEqual(['a']);
  });

  it('没有待发值时 flush 不触发 sink', async () => {
    const sink = vi.fn(async () => {});
    const throttled = createThrottle<string>(500, sink);
    await throttled.flush();
    expect(sink).not.toHaveBeenCalled();
  });

  it('sink 抛错不会冒泡, 后续 push 仍然生效', async () => {
    const seen: string[] = [];
    const throttled = createThrottle<string>(500, async (v) => {
      if (v === 'bad') throw new Error('boom');
      seen.push(v);
    });

    throttled.push('bad');
    await vi.advanceTimersByTimeAsync(500);
    throttled.push('good');
    await vi.advanceTimersByTimeAsync(500);
    await throttled.flush();

    expect(seen).toEqual(['good']);
  });
});
```

- [ ] **Step 4: 运行三个测试确认失败**

Run: `npx vitest run tests/infra`
Expected: FAIL，三个文件都报 `Failed to resolve import`

- [ ] **Step 5: 写 src/infra/bounded-set.ts**

```ts
/**
 * 固定容量的插入序集合, 超容淘汰最早插入项。
 * 用于 message_id 去重 (容量 1 万), 防止 WS 重投导致重复消费。
 */
export class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly maxSize: number) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** 首次出现返回 true; 已存在返回 false。 */
  add(key: string): boolean {
    if (this.items.has(key)) return false;
    this.items.add(key);
    while (this.items.size > this.maxSize) {
      const oldest = this.items.values().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.items.size;
  }
}
```

- [ ] **Step 6: 写 src/infra/chat-lock.ts**

```ts
/**
 * 按 key 串行的任务队列: 同一会话的消息依次处理, 防止并发争抢同一个 claude session。
 * 不同 key 之间互不阻塞。
 */
export class ChatLock {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);

    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });

    return result;
  }
}
```

- [ ] **Step 7: 写 src/infra/throttle.ts**

```ts
export interface Throttled<T> {
  /** 覆盖式提交待发值; 距上次触发不足 intervalMs 时合并。 */
  push(value: T): void;
  /** 立即冲刷待发值, 并等待所有已排队的 sink 调用结束。 */
  flush(): Promise<void>;
}

/**
 * 尾沿节流: push 后至多 intervalMs 触发一次 sink, 取该窗口内最后一个值。
 * sink 之间严格串行 (卡片 patch 不能乱序), sink 抛错只吞不冒泡。
 */
export function createThrottle<T>(
  intervalMs: number,
  sink: (value: T) => Promise<void>,
): Throttled<T> {
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const emit = (): void => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    chain = chain.then(() => sink(value)).catch(() => undefined);
  };

  return {
    push(value: T): void {
      pending = { value };
      if (timer === null) timer = setTimeout(emit, intervalMs);
    },
    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      emit();
      await chain;
    },
  };
}
```

- [ ] **Step 8: 写 src/infra/logger.ts**

```ts
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pino, { type Logger } from 'pino';

/** spec 规定的日志落点。 */
export const LOG_FILE = resolve(process.cwd(), 'runtime/logs/bot.log');

/** 同时写 stdout 与 runtime/logs/bot.log。 */
export function createLogger(level: string): Logger {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  return pino(
    { level },
    pino.multistream([
      { level: level as pino.Level, stream: process.stdout },
      {
        level: level as pino.Level,
        stream: createWriteStream(LOG_FILE, { flags: 'a' }),
      },
    ]),
  );
}

export type { Logger };
```

`logger.ts` 只有副作用没有分支逻辑，不写单测；它由 Task 14 的端到端手动验证覆盖。

- [ ] **Step 9: 运行测试确认通过**

Run: `npx vitest run tests/infra`
Expected: PASS（11 个用例）

- [ ] **Step 10: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 11: 提交**

```bash
git add src/infra tests/infra
git commit -m "feat: 基础设施模块 (logger/LRU 去重/会话锁/节流)"
```

---

### Task 3: 消息类型定义与飞书事件解析

**Files:**
- Create: `src/types/feishu.ts`, `src/feishu/parse.ts`
- Test: `tests/feishu/parse.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type ChatType = 'p2p' | 'group'`
  - `interface MentionRef { key: string; openId: string; name: string }`
  - `interface ParsedMessage { messageId: string; rootId: string; parentId: string; chatId: string; chatType: ChatType; senderOpenId: string; text: string; mentions: MentionRef[]; mentionsAll: boolean; createTimeMs: number }`
  - `parseMessageEvent(event: unknown): ParsedMessage | null`（返回 `null` = 静默忽略）

- [ ] **Step 1: 写 tests/feishu/parse.test.ts（失败的测试）**

```ts
import { describe, expect, it } from 'vitest';
import { parseMessageEvent } from '../../src/feishu/parse';

const textEvent = (overrides: Record<string, unknown> = {}) => ({
  sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
  message: {
    message_id: 'om_1',
    root_id: '',
    parent_id: '',
    create_time: '1700000000000',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '帮我看下这个报错' }),
    mentions: [],
    ...overrides,
  },
});

describe('parseMessageEvent', () => {
  it('解析私聊纯文本消息', () => {
    const parsed = parseMessageEvent(textEvent());
    expect(parsed).toEqual({
      messageId: 'om_1',
      rootId: '',
      parentId: '',
      chatId: 'oc_1',
      chatType: 'p2p',
      senderOpenId: 'ou_sender',
      text: '帮我看下这个报错',
      mentions: [],
      mentionsAll: false,
      createTimeMs: 1700000000000,
    });
  });

  it('剥掉 @提及占位符并保留 mentions 明细', () => {
    const parsed = parseMessageEvent(
      textEvent({
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 这个接口怎么调' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'agentlark' },
        ],
      }),
    );
    expect(parsed?.text).toBe('这个接口怎么调');
    expect(parsed?.chatType).toBe('group');
    expect(parsed?.mentions).toEqual([
      { key: '@_user_1', openId: 'ou_bot', name: 'agentlark' },
    ]);
  });

  it('识别 @全体成员', () => {
    const parsed = parseMessageEvent(
      textEvent({
        chat_type: 'group',
        content: JSON.stringify({ text: '@_all 服务挂了吗' }),
      }),
    );
    expect(parsed?.mentionsAll).toBe(true);
    expect(parsed?.text).toBe('服务挂了吗');
  });

  it('保留换行, 只合并多余的空格', () => {
    const parsed = parseMessageEvent(
      textEvent({ content: JSON.stringify({ text: 'a   b\n\nc' }) }),
    );
    expect(parsed?.text).toBe('a b\n\nc');
  });

  it('只 @不说话时正文为空字符串', () => {
    const parsed = parseMessageEvent(
      textEvent({
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 ' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'agentlark' },
        ],
      }),
    );
    expect(parsed?.text).toBe('');
  });

  it('非 text 类型返回 null (静默忽略)', () => {
    for (const type of ['image', 'post', 'file', 'audio', 'media']) {
      expect(parseMessageEvent(textEvent({ message_type: type }))).toBeNull();
    }
  });

  it('content 不是合法 JSON 时返回 null', () => {
    expect(parseMessageEvent(textEvent({ content: 'not-json' }))).toBeNull();
  });

  it('缺关键字段时返回 null', () => {
    expect(parseMessageEvent({})).toBeNull();
    expect(parseMessageEvent(null)).toBeNull();
    expect(
      parseMessageEvent({ message: { message_id: 'om_1' } }),
    ).toBeNull();
  });

  it('未知 chat_type 返回 null', () => {
    expect(parseMessageEvent(textEvent({ chat_type: 'topic' }))).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/feishu/parse.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/feishu/parse"`

- [ ] **Step 3: 写 src/types/feishu.ts**

```ts
export type ChatType = 'p2p' | 'group';

export interface MentionRef {
  /** 正文里的占位符, 形如 "@_user_1"。 */
  key: string;
  openId: string;
  name: string;
}

/** 归一化后的消息, 下游 filter / commands / message 只认这个结构。 */
export interface ParsedMessage {
  messageId: string;
  rootId: string;
  parentId: string;
  chatId: string;
  chatType: ChatType;
  senderOpenId: string;
  /** 已剥掉 @占位符并 trim 过的正文。 */
  text: string;
  mentions: MentionRef[];
  mentionsAll: boolean;
  createTimeMs: number;
}
```

- [ ] **Step 4: 写 src/feishu/parse.ts**

```ts
import type { ChatType, MentionRef, ParsedMessage } from '../types/feishu';

/** 飞书 @全体成员在正文里的占位符。 */
const AT_ALL_KEY = '@_all';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

function readMentions(raw: unknown): MentionRef[] {
  if (!Array.isArray(raw)) return [];
  const result: MentionRef[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const key = asString(record.key);
    const openId = asString(asRecord(record.id)?.open_id);
    if (!key || !openId) continue;
    result.push({ key, openId, name: asString(record.name) });
  }
  return result;
}

/** 去掉 @占位符, 合并多余空格但保留换行 (代码块/多段问题要留结构)。 */
function stripMentions(text: string, mentions: MentionRef[]): string {
  let out = text;
  for (const mention of mentions) out = out.split(mention.key).join('');
  out = out.split(AT_ALL_KEY).join('');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 原始 im.message.receive_v1 事件 → ParsedMessage。
 * 返回 null 表示静默忽略 (不支持的消息类型 / 结构不完整), 调用方不得回复用户。
 * Plan 1 只支持 text; image / post / 引用消息在 Plan 2 接入。
 */
export function parseMessageEvent(event: unknown): ParsedMessage | null {
  const root = asRecord(event);
  if (!root) return null;

  const message = asRecord(root.message);
  if (!message) return null;

  if (asString(message.message_type) !== 'text') return null;

  const messageId = asString(message.message_id);
  const chatId = asString(message.chat_id);
  if (!messageId || !chatId) return null;

  const chatTypeRaw = asString(message.chat_type);
  if (chatTypeRaw !== 'p2p' && chatTypeRaw !== 'group') return null;
  const chatType: ChatType = chatTypeRaw;

  const senderOpenId = asString(
    asRecord(asRecord(root.sender)?.sender_id)?.open_id,
  );
  if (!senderOpenId) return null;

  let rawText = '';
  try {
    const content = JSON.parse(asString(message.content));
    rawText = asString(asRecord(content)?.text);
  } catch {
    return null;
  }

  const mentions = readMentions(message.mentions);

  return {
    messageId,
    rootId: asString(message.root_id),
    parentId: asString(message.parent_id),
    chatId,
    chatType,
    senderOpenId,
    text: stripMentions(rawText, mentions),
    mentions,
    mentionsAll: rawText.includes(AT_ALL_KEY),
    createTimeMs: Number(asString(message.create_time)) || 0,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/feishu/parse.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 6: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 7: 提交**

```bash
git add src/types/feishu.ts src/feishu/parse.ts tests/feishu/parse.test.ts
git commit -m "feat: 飞书消息事件解析与 ParsedMessage 类型"
```

---

### Task 4: @提及检测与消息过滤

**Files:**
- Create: `src/feishu/mention.ts`, `src/handler/filter.ts`
- Test: `tests/handler/filter.test.ts`

**Interfaces:**
- Consumes: `ParsedMessage`（Task 3）、`BoundedSet`（Task 2）
- Produces:
  - `isBotMentioned(msg: ParsedMessage, botOpenId: string): boolean`
  - `type DropReason = 'duplicate' | 'self' | 'group-not-allowed' | 'at-all' | 'not-mentioned' | 'empty'`
  - `type FilterDecision = { action: 'process' } | { action: 'drop'; reason: DropReason }`
  - `interface FilterOptions { botOpenId: string; ignoreAtAll: boolean; allowedGroupChats: string[]; seen: { add(key: string): boolean } }`
  - `filterMessage(msg: ParsedMessage, opts: FilterOptions): FilterDecision`

- [ ] **Step 1: 写 tests/handler/filter.test.ts（失败的测试）**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/handler/filter.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/handler/filter"`

- [ ] **Step 3: 写 src/feishu/mention.ts**

```ts
import type { ParsedMessage } from '../types/feishu';

/**
 * 是否 @了本机器人。botOpenId 为空 (bot/v3/info 解析失败) 时一律返回 false,
 * 表现为群聊不触发 —— 宁可不响应, 也不要在群里对每条消息作答。
 */
export function isBotMentioned(msg: ParsedMessage, botOpenId: string): boolean {
  if (!botOpenId) return false;
  return msg.mentions.some((mention) => mention.openId === botOpenId);
}
```

- [ ] **Step 4: 写 src/handler/filter.ts**

```ts
import { isBotMentioned } from '../feishu/mention';
import type { ParsedMessage } from '../types/feishu';

export type DropReason =
  | 'duplicate'
  | 'self'
  | 'group-not-allowed'
  | 'at-all'
  | 'not-mentioned'
  | 'empty';

export type FilterDecision =
  | { action: 'process' }
  | { action: 'drop'; reason: DropReason };

export interface FilterOptions {
  botOpenId: string;
  ignoreAtAll: boolean;
  /** 留空 = 允许全部群。 */
  allowedGroupChats: string[];
  /** message_id 去重集合; add 返回 true 表示首次出现。 */
  seen: { add(key: string): boolean };
}

/**
 * 纯函数: 决定一条消息该不该进主流水线。
 * 顺序与 spec 的数据流一致: 去重 → self → 群白名单 → @all → 群须 @bot → 空文本。
 * 被丢弃的消息一律不回复用户 (静默)。
 */
export function filterMessage(
  msg: ParsedMessage,
  opts: FilterOptions,
): FilterDecision {
  if (!opts.seen.add(msg.messageId)) {
    return { action: 'drop', reason: 'duplicate' };
  }

  if (opts.botOpenId && msg.senderOpenId === opts.botOpenId) {
    return { action: 'drop', reason: 'self' };
  }

  if (msg.chatType === 'group') {
    if (
      opts.allowedGroupChats.length > 0 &&
      !opts.allowedGroupChats.includes(msg.chatId)
    ) {
      return { action: 'drop', reason: 'group-not-allowed' };
    }

    if (msg.mentionsAll && opts.ignoreAtAll) {
      return { action: 'drop', reason: 'at-all' };
    }

    if (!isBotMentioned(msg, opts.botOpenId)) {
      return { action: 'drop', reason: 'not-mentioned' };
    }
  }

  if (msg.text.trim().length === 0) {
    return { action: 'drop', reason: 'empty' };
  }

  return { action: 'process' };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/handler/filter.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 6: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 7: 提交**

```bash
git add src/feishu/mention.ts src/handler/filter.ts tests/handler/filter.test.ts
git commit -m "feat: @提及检测与消息过滤规则"
```

---

### Task 5: 内置指令（严格全匹配，不启动模型）

**Files:**
- Create: `src/handler/commands.ts`
- Test: `tests/handler/commands.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type CommandMatch = { kind: 'reset' } | { kind: 'whoami' } | { kind: 'canned'; text: string }`
  - `matchCommand(text: string): CommandMatch | null`
  - `RESET_REPLY: string`、`WHOAMI_GROUP_HINT: string`

- [ ] **Step 1: 写 tests/handler/commands.test.ts（失败的测试）**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/handler/commands.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/handler/commands"`

- [ ] **Step 3: 写 src/handler/commands.ts**

```ts
export type CommandMatch =
  | { kind: 'reset' }
  | { kind: 'whoami' }
  | { kind: 'canned'; text: string };

export const RESET_REPLY = '已清空上下文, 下一条消息我们从头开始 🧹';

export const WHOAMI_GROUP_HINT =
  '群里拿到的是群 id, 不是你的 open_id。请私聊我再发一次 /whoami。';

const RESET_WORDS = new Set(['/new', '/reset', '新对话', '重置']);
const WHOAMI_WORDS = new Set(['/whoami', '/myid']);

/** 固定直答: 秒回, 不启动模型, 不占用会话。 */
const CANNED: Array<{ words: string[]; text: string }> = [
  {
    words: ['你好', '您好', 'hi', 'hello'],
    text: '你好 👋 我是 agentlark, 直接把问题发给我就行, 不用客气。',
  },
  {
    words: ['ping', '测试', 'test'],
    text: 'pong ✅ 服务在线。',
  },
  {
    words: ['你是谁', '你是什么'],
    text:
      '我是 agentlark — 你在飞书里的智能分身, 背后跑的是本机的 Claude Code。' +
      '直接提问即可; 想换个话题发 /new。',
  },
];

/**
 * 严格全匹配 (只 trim 前后空白): 指令前后带其他文字一律不匹配, 交给模型处理。
 * 匹配上的指令不启动模型, 后续计划里也不扣群聊额度。
 */
export function matchCommand(text: string): CommandMatch | null {
  const normalized = text.trim();
  if (normalized.length === 0) return null;

  const lowered = normalized.toLowerCase();

  if (RESET_WORDS.has(normalized) || RESET_WORDS.has(lowered)) {
    return { kind: 'reset' };
  }

  if (WHOAMI_WORDS.has(lowered)) {
    return { kind: 'whoami' };
  }

  for (const entry of CANNED) {
    if (entry.words.includes(normalized) || entry.words.includes(lowered)) {
      return { kind: 'canned', text: entry.text };
    }
  }

  return null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/handler/commands.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 6: 提交**

```bash
git add src/handler/commands.ts tests/handler/commands.test.ts
git commit -m "feat: 内置指令严格全匹配 (/new /whoami 固定直答)"
```

---

### Task 6: 飞书 API 薄封装与 bot open_id 解析

**Files:**
- Create: `src/feishu/client.ts`, `src/feishu/bot-info.ts`
- Test: `tests/feishu/client.test.ts`, `tests/feishu/bot-info.test.ts`

**背景（实现者必读）：** 本项目**不直接调用 SDK 的具体资源方法**（如 `client.im.message.create`），而是统一走 `client.request({ method, url, data })` 裸 HTTP 逃生口。原因有二：一是 SDK 版本间资源方法名会变，裸路径不会；二是把飞书 API 收敛成一个 `FeishuApi` 接口后，下游全部模块只依赖这个接口，测试注入假实现即可，不需要 mock 整个 SDK。

**Interfaces:**
- Consumes: `Logger`（Task 2）
- Produces:
  - `interface LarkRequester { request<T = any>(payload: { method: string; url: string; data?: unknown; params?: unknown }): Promise<T> }`
  - `interface FeishuApi { sendMessage(input: { chatId: string; msgType: MsgType; content: string }): Promise<string>; replyMessage(input: { messageId: string; msgType: MsgType; content: string }): Promise<string>; patchMessage(input: { messageId: string; content: string }): Promise<void>; createReaction(input: { messageId: string; emoji: string }): Promise<void>; getBotOpenId(): Promise<string> }`（`sendMessage` / `replyMessage` 返回新消息的 `message_id`）
  - `type MsgType = 'text' | 'interactive'`
  - `class FeishuApiError extends Error { readonly code: number; readonly api: string }`
  - `createLarkClient(appId: string, appSecret: string): LarkRequester`
  - `createFeishuApi(requester: LarkRequester): FeishuApi`
  - `resolveBotOpenId(api: FeishuApi, configured: string, logger: Logger): Promise<string>`

- [ ] **Step 1: 写 tests/feishu/client.test.ts（失败的测试）**

```ts
import { describe, expect, it, vi } from 'vitest';
import { FeishuApiError, createFeishuApi } from '../../src/feishu/client';

const ok = (data: unknown) => ({ code: 0, msg: 'success', data });

describe('createFeishuApi', () => {
  it('sendMessage 走 POST /open-apis/im/v1/messages 并回传 message_id', async () => {
    const request = vi.fn().mockResolvedValue(ok({ message_id: 'om_new' }));
    const api = createFeishuApi({ request });

    const id = await api.sendMessage({
      chatId: 'oc_1',
      msgType: 'interactive',
      content: '{"schema":"2.0"}',
    });

    expect(id).toBe('om_new');
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_1',
        msg_type: 'interactive',
        content: '{"schema":"2.0"}',
      },
    });
  });

  it('replyMessage 走 reply 路径', async () => {
    const request = vi.fn().mockResolvedValue(ok({ message_id: 'om_reply' }));
    const api = createFeishuApi({ request });

    const id = await api.replyMessage({
      messageId: 'om_1',
      msgType: 'text',
      content: '{"text":"hi"}',
    });

    expect(id).toBe('om_reply');
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/open-apis/im/v1/messages/om_1/reply',
      data: { msg_type: 'text', content: '{"text":"hi"}' },
    });
  });

  it('patchMessage 走 PATCH 路径', async () => {
    const request = vi.fn().mockResolvedValue(ok({}));
    const api = createFeishuApi({ request });

    await api.patchMessage({ messageId: 'om_1', content: '{"schema":"2.0"}' });

    expect(request).toHaveBeenCalledWith({
      method: 'PATCH',
      url: '/open-apis/im/v1/messages/om_1',
      data: { content: '{"schema":"2.0"}' },
    });
  });

  it('createReaction 走 reactions 路径', async () => {
    const request = vi.fn().mockResolvedValue(ok({}));
    const api = createFeishuApi({ request });

    await api.createReaction({ messageId: 'om_1', emoji: 'Typing' });

    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/open-apis/im/v1/messages/om_1/reactions',
      data: { reaction_type: { emoji_type: 'Typing' } },
    });
  });

  it('getBotOpenId 从 bot/v3/info 取 open_id', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ code: 0, bot: { open_id: 'ou_bot' } });
    const api = createFeishuApi({ request });

    await expect(api.getBotOpenId()).resolves.toBe('ou_bot');
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
  });

  it('业务错误码转成带 code 的 FeishuApiError', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ code: 99991672, msg: 'no permission' });
    const api = createFeishuApi({ request });

    const failure = api.sendMessage({
      chatId: 'oc_1',
      msgType: 'text',
      content: '{}',
    });

    await expect(failure).rejects.toBeInstanceOf(FeishuApiError);
    await expect(failure).rejects.toMatchObject({ code: 99991672 });
  });

  it('兼容 SDK 已展平 data 的返回形态', async () => {
    const request = vi.fn().mockResolvedValue({ code: 0, message_id: 'om_flat' });
    const api = createFeishuApi({ request });

    await expect(
      api.sendMessage({ chatId: 'oc_1', msgType: 'text', content: '{}' }),
    ).resolves.toBe('om_flat');
  });

  it('响应里没有 message_id 时抛 FeishuApiError', async () => {
    const request = vi.fn().mockResolvedValue(ok({}));
    const api = createFeishuApi({ request });

    await expect(
      api.sendMessage({ chatId: 'oc_1', msgType: 'text', content: '{}' }),
    ).rejects.toBeInstanceOf(FeishuApiError);
  });
});
```

- [ ] **Step 2: 写 tests/feishu/bot-info.test.ts（失败的测试）**

```ts
import { describe, expect, it, vi } from 'vitest';
import { resolveBotOpenId } from '../../src/feishu/bot-info';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('resolveBotOpenId', () => {
  it('配置了 FEISHU_BOT_OPEN_ID 时直接返回, 不发请求', async () => {
    const api = { getBotOpenId: vi.fn() };
    await expect(
      resolveBotOpenId(api as never, 'ou_configured', logger as never),
    ).resolves.toBe('ou_configured');
    expect(api.getBotOpenId).not.toHaveBeenCalled();
  });

  it('未配置时调 bot/v3/info 解析', async () => {
    const api = { getBotOpenId: vi.fn().mockResolvedValue('ou_resolved') };
    await expect(
      resolveBotOpenId(api as never, '', logger as never),
    ).resolves.toBe('ou_resolved');
  });

  it('解析失败返回空串并告警, 不抛错阻断启动', async () => {
    const warn = vi.fn();
    const api = {
      getBotOpenId: vi.fn().mockRejectedValue(new Error('network down')),
    };
    await expect(
      resolveBotOpenId(api as never, '', { ...logger, warn } as never),
    ).resolves.toBe('');
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 运行两个测试确认失败**

Run: `npx vitest run tests/feishu/client.test.ts tests/feishu/bot-info.test.ts`
Expected: FAIL，两个文件都报 `Failed to resolve import`

- [ ] **Step 4: 写 src/feishu/client.ts**

```ts
import * as Lark from '@larksuiteoapi/node-sdk';

export type MsgType = 'text' | 'interactive';

/** SDK 的裸 HTTP 逃生口; 只依赖这一个方法, 不绑定 SDK 的资源方法名。 */
export interface LarkRequester {
  request<T = any>(payload: {
    method: string;
    url: string;
    data?: unknown;
    params?: unknown;
  }): Promise<T>;
}

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly api: string,
  ) {
    super(message);
    this.name = 'FeishuApiError';
  }
}

export interface FeishuApi {
  /** 主动发消息, 返回新消息的 message_id。 */
  sendMessage(input: {
    chatId: string;
    msgType: MsgType;
    content: string;
  }): Promise<string>;
  /** 引用回复某条消息, 返回新消息的 message_id。 */
  replyMessage(input: {
    messageId: string;
    msgType: MsgType;
    content: string;
  }): Promise<string>;
  /** 更新已发出的卡片。 */
  patchMessage(input: { messageId: string; content: string }): Promise<void>;
  createReaction(input: { messageId: string; emoji: string }): Promise<void>;
  getBotOpenId(): Promise<string>;
}

export function createLarkClient(
  appId: string,
  appSecret: string,
): LarkRequester {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  }) as unknown as LarkRequester;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

/** SDK 有时展平 data, 有时保留 { code, data } 信封, 两种都吃。 */
function unwrap(response: unknown, api: string): Record<string, unknown> {
  const body = asRecord(response);
  const code = typeof body.code === 'number' ? body.code : 0;
  if (code !== 0) {
    const msg = typeof body.msg === 'string' ? body.msg : 'unknown error';
    throw new FeishuApiError(`${api} failed: ${msg} (code=${code})`, code, api);
  }
  return 'data' in body ? asRecord(body.data) : body;
}

function readMessageId(payload: Record<string, unknown>, api: string): string {
  const id = payload.message_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new FeishuApiError(`${api} returned no message_id`, 0, api);
  }
  return id;
}

export function createFeishuApi(requester: LarkRequester): FeishuApi {
  return {
    async sendMessage({ chatId, msgType, content }) {
      const response = await requester.request({
        method: 'POST',
        url: '/open-apis/im/v1/messages',
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content },
      });
      return readMessageId(unwrap(response, 'im.message.create'), 'im.message.create');
    },

    async replyMessage({ messageId, msgType, content }) {
      const response = await requester.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${messageId}/reply`,
        data: { msg_type: msgType, content },
      });
      return readMessageId(unwrap(response, 'im.message.reply'), 'im.message.reply');
    },

    async patchMessage({ messageId, content }) {
      const response = await requester.request({
        method: 'PATCH',
        url: `/open-apis/im/v1/messages/${messageId}`,
        data: { content },
      });
      unwrap(response, 'im.message.patch');
    },

    async createReaction({ messageId, emoji }) {
      const response = await requester.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${messageId}/reactions`,
        data: { reaction_type: { emoji_type: emoji } },
      });
      unwrap(response, 'im.messageReaction.create');
    },

    async getBotOpenId() {
      const response = await requester.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      const payload = unwrap(response, 'bot.v3.info');
      const openId = asRecord(payload.bot).open_id;
      return typeof openId === 'string' ? openId : '';
    },
  };
}
```

- [ ] **Step 5: 写 src/feishu/bot-info.ts**

```ts
import type { Logger } from '../infra/logger';
import type { FeishuApi } from './client';

/**
 * 解析机器人自己的 open_id: env 配置优先, 否则调 bot/v3/info。
 * 该接口权限标注为「无」, 但要求「应用能力 → 机器人」已启用并发布。
 * 解析失败只告警不抛错 —— 启动不阻断, 代价是群聊 @ 检测失效 (filter 会全部丢弃)。
 */
export async function resolveBotOpenId(
  api: FeishuApi,
  configured: string,
  logger: Logger,
): Promise<string> {
  if (configured) return configured;

  try {
    const openId = await api.getBotOpenId();
    if (openId) {
      logger.info({ openId }, 'bot-info: bot open_id resolved');
      return openId;
    }
    logger.warn('bot-info: bot open_id unresolved (empty response)');
    return '';
  } catch (error) {
    logger.warn(
      { err: error },
      'bot-info: bot open_id unresolved; group @ detection disabled',
    );
    return '';
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/feishu/client.test.ts tests/feishu/bot-info.test.ts`
Expected: PASS（11 个用例）

- [ ] **Step 7: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 8: 提交**

```bash
git add src/feishu/client.ts src/feishu/bot-info.ts tests/feishu/client.test.ts tests/feishu/bot-info.test.ts
git commit -m "feat: 飞书 API 薄封装与 bot open_id 解析"
```

---

### Task 7: 纯文本回复、卡片 markdown 长度硬限与 Typing 回执

**Files:**
- Create: `src/feishu/markdown.ts`, `src/feishu/reply.ts`, `src/feishu/react.ts`
- Test: `tests/feishu/markdown.test.ts`, `tests/feishu/reply.test.ts`

**Interfaces:**
- Consumes: `FeishuApi`（Task 6）、`ParsedMessage`（Task 3）、`Logger`（Task 2）
- Produces:
  - `MAX_CARD_MARKDOWN = 3800`
  - `toCardMarkdown(text: string): string`
  - `type Replier = (msg: ParsedMessage, text: string) => Promise<void>`
  - `createReplier(api: FeishuApi, logger: Logger): Replier`
  - `reactTyping(api: FeishuApi, messageId: string, logger: Logger): Promise<void>`

- [ ] **Step 1: 写 tests/feishu/markdown.test.ts（失败的测试）**

```ts
import { describe, expect, it } from 'vitest';
import { MAX_CARD_MARKDOWN, toCardMarkdown } from '../../src/feishu/markdown';

describe('toCardMarkdown', () => {
  it('短文本原样返回', () => {
    expect(toCardMarkdown('部署完成 ✅')).toBe('部署完成 ✅');
  });

  it('去掉首尾空白', () => {
    expect(toCardMarkdown('\n\n答案\n\n')).toBe('答案');
  });

  it('空文本给出占位, 避免飞书拒收空卡片', () => {
    expect(toCardMarkdown('')).toBe('_(模型没有返回内容)_');
    expect(toCardMarkdown('   ')).toBe('_(模型没有返回内容)_');
  });

  it('超长文本截断到硬限内并带截断提示', () => {
    const out = toCardMarkdown('字'.repeat(MAX_CARD_MARKDOWN + 500));
    expect(out.length).toBeLessThanOrEqual(MAX_CARD_MARKDOWN);
    expect(out.endsWith('…(内容过长已截断)')).toBe(true);
  });

  it('刚好等于硬限的文本不截断', () => {
    const exact = '字'.repeat(MAX_CARD_MARKDOWN);
    expect(toCardMarkdown(exact)).toBe(exact);
  });
});
```

- [ ] **Step 2: 写 tests/feishu/reply.test.ts（失败的测试）**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createReplier } from '../../src/feishu/reply';
import type { ParsedMessage } from '../../src/types/feishu';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const msg = (chatType: 'p2p' | 'group'): ParsedMessage => ({
  messageId: 'om_1',
  rootId: '',
  parentId: '',
  chatId: 'oc_1',
  chatType,
  senderOpenId: 'ou_sender',
  text: 'hi',
  mentions: [],
  mentionsAll: false,
  createTimeMs: 0,
});

describe('createReplier', () => {
  it('群聊引用原消息回复', async () => {
    const api = {
      replyMessage: vi.fn().mockResolvedValue('om_reply'),
      sendMessage: vi.fn(),
    };
    await createReplier(api as never, logger as never)(msg('group'), '答案');

    expect(api.replyMessage).toHaveBeenCalledWith({
      messageId: 'om_1',
      msgType: 'text',
      content: JSON.stringify({ text: '答案' }),
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('私聊直发不引用', async () => {
    const api = {
      replyMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue('om_new'),
    };
    await createReplier(api as never, logger as never)(msg('p2p'), '答案');

    expect(api.sendMessage).toHaveBeenCalledWith({
      chatId: 'oc_1',
      msgType: 'text',
      content: JSON.stringify({ text: '答案' }),
    });
    expect(api.replyMessage).not.toHaveBeenCalled();
  });

  it('发送失败只记日志不抛错 (回复是尽力而为)', async () => {
    const error = vi.fn();
    const api = {
      replyMessage: vi.fn(),
      sendMessage: vi.fn().mockRejectedValue(new Error('boom')),
    };
    await expect(
      createReplier(api as never, { ...logger, error } as never)(msg('p2p'), 'x'),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 运行两个测试确认失败**

Run: `npx vitest run tests/feishu/markdown.test.ts tests/feishu/reply.test.ts`
Expected: FAIL，两个文件都报 `Failed to resolve import`

- [ ] **Step 4: 写 src/feishu/markdown.ts**

```ts
/** 单个 markdown 元素的正文硬限 (spec: markdown 3800 字)。 */
export const MAX_CARD_MARKDOWN = 3800;

const TRUNCATED_SUFFIX = '…(内容过长已截断)';
const EMPTY_PLACEHOLDER = '_(模型没有返回内容)_';

/** 归一化模型输出, 保证落进卡片 markdown 元素时不空、不超限。 */
export function toCardMarkdown(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return EMPTY_PLACEHOLDER;
  if (trimmed.length <= MAX_CARD_MARKDOWN) return trimmed;

  const keep = MAX_CARD_MARKDOWN - TRUNCATED_SUFFIX.length;
  return trimmed.slice(0, keep) + TRUNCATED_SUFFIX;
}
```

- [ ] **Step 5: 写 src/feishu/reply.ts**

```ts
import type { Logger } from '../infra/logger';
import type { ParsedMessage } from '../types/feishu';
import type { FeishuApi } from './client';

export type Replier = (msg: ParsedMessage, text: string) => Promise<void>;

/**
 * 纯文本回复: 群聊引用原消息, 私聊直发。
 * 用于内置指令直答, 以及建卡失败时的降级路径。
 * 发送失败只记日志不抛错 —— 此时已经没有别的通道能告诉用户了。
 */
export function createReplier(api: FeishuApi, logger: Logger): Replier {
  return async (msg, text) => {
    const content = JSON.stringify({ text });
    try {
      if (msg.chatType === 'group') {
        await api.replyMessage({
          messageId: msg.messageId,
          msgType: 'text',
          content,
        });
      } else {
        await api.sendMessage({
          chatId: msg.chatId,
          msgType: 'text',
          content,
        });
      }
    } catch (error) {
      logger.error({ err: error, chatId: msg.chatId }, 'reply: send failed');
    }
  };
}
```

- [ ] **Step 6: 写 src/feishu/react.ts**

```ts
import type { Logger } from '../infra/logger';
import type { FeishuApi } from './client';

/** 收到可处理消息后先点一个 Typing 表情, 让用户知道已收到。失败无害, 只记日志。 */
export async function reactTyping(
  api: FeishuApi,
  messageId: string,
  logger: Logger,
): Promise<void> {
  try {
    await api.createReaction({ messageId, emoji: 'Typing' });
  } catch (error) {
    logger.debug({ err: error, messageId }, 'react: typing reaction failed');
  }
}
```

`react.ts` 是三行的 try/catch 包装，逻辑分支已由 `reply.ts` 的失败用例覆盖，不单独写测试。

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/feishu/markdown.test.ts tests/feishu/reply.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 8: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 9: 提交**

```bash
git add src/feishu/markdown.ts src/feishu/reply.ts src/feishu/react.ts tests/feishu/markdown.test.ts tests/feishu/reply.test.ts
git commit -m "feat: 纯文本回复、卡片 markdown 硬限与 Typing 回执"
```

---

### Task 8: 流式卡片（建卡 → 节流刷进度 → 终态 patch → 失败续传）

**Files:**
- Create: `src/feishu/stream-card-render.ts`, `src/feishu/stream-card.ts`
- Test: `tests/feishu/stream-card-render.test.ts`, `tests/feishu/stream-card.test.ts`

**Interfaces:**
- Consumes: `FeishuApi`（Task 6）、`toCardMarkdown`（Task 7）、`createThrottle`（Task 2）、`Logger`（Task 2）
- Produces:
  - `MAX_CARD_BYTES = 30000`、`MAX_PATCH_FAILURES = 3`
  - `interface CardState { progress: string[]; answer: string; failed: boolean }`
  - `renderCard(state: CardState): { card: object; droppedProgress: number }`（自带 30KB 裁剪，返回被裁掉的进度行数）
  - `interface StreamCardHandle { addProgress(line: string): void; finalize(text: string): Promise<void>; fail(text: string): Promise<void> }`
  - `openStreamCard(deps: StreamCardDeps, target: StreamCardTarget): Promise<StreamCardHandle>`
  - `interface StreamCardDeps { api: FeishuApi; logger: Logger; throttleMs: number }`
  - `interface StreamCardTarget { chatId: string; messageId: string; chatType: 'p2p' | 'group' }`

- [ ] **Step 1: 写 tests/feishu/stream-card-render.test.ts（失败的测试）**

```ts
import { describe, expect, it } from 'vitest';
import {
  MAX_CARD_BYTES,
  renderCard,
} from '../../src/feishu/stream-card-render';

describe('renderCard', () => {
  it('没有答案时渲染「思考中」', () => {
    const { card } = renderCard({ progress: [], answer: '', failed: false });
    expect(JSON.stringify(card)).toContain('💭 思考中');
  });

  it('卡片使用 schema 2.0 并允许多次更新', () => {
    const { card } = renderCard({ progress: [], answer: '', failed: false }) as {
      card: any;
    };
    expect(card.schema).toBe('2.0');
    expect(card.config.update_multi).toBe(true);
  });

  it('有答案时答案取代「思考中」', () => {
    const { card } = renderCard({
      progress: ['📖 Read a.ts'],
      answer: '这是答案',
      failed: false,
    });
    const json = JSON.stringify(card);
    expect(json).toContain('这是答案');
    expect(json).not.toContain('💭 思考中');
  });

  it('进度行渲染在分隔线之后', () => {
    const { card } = renderCard({
      progress: ['📖 Read a.ts', '🔧 Bash npm test'],
      answer: '',
      failed: false,
    }) as { card: any };
    expect(card.body.elements.some((e: any) => e.tag === 'hr')).toBe(true);
    expect(JSON.stringify(card)).toContain('🔧 Bash npm test');
  });

  it('没有进度行时不渲染分隔线', () => {
    const { card } = renderCard({
      progress: [],
      answer: '答案',
      failed: false,
    }) as { card: any };
    expect(card.body.elements.some((e: any) => e.tag === 'hr')).toBe(false);
  });

  it('超过 30KB 时裁掉最早的进度行, 并报告裁掉了几行', () => {
    const progress = Array.from({ length: 400 }, (_, i) =>
      `🔧 Bash ${'x'.repeat(100)} <${String(i).padStart(3, '0')}>`,
    );
    const { card, droppedProgress } = renderCard({
      progress,
      answer: '',
      failed: false,
    });

    expect(
      Buffer.byteLength(JSON.stringify(card), 'utf8'),
    ).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(droppedProgress).toBeGreaterThan(0);
    expect(JSON.stringify(card)).toContain('<399>');
    expect(JSON.stringify(card)).not.toContain('<000>');
  });

  it('答案本身超限时靠 markdown 硬限收敛, 仍不超 30KB', () => {
    const { card } = renderCard({
      progress: [],
      answer: '字'.repeat(50000),
      failed: false,
    });
    expect(
      Buffer.byteLength(JSON.stringify(card), 'utf8'),
    ).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });

  it('按 UTF-8 字节而不是字符数裁剪 (中文一个字 3 字节)', () => {
    // 12000 行 × 每行 4 个中文字: 字符数远低于 30000, 字节数远超
    const progress = Array.from({ length: 12000 }, (_, i) => `\u{1f527} 执行中 ${i}`);
    const { card, droppedProgress } = renderCard({
      progress,
      answer: '',
      failed: false,
    });

    const json = JSON.stringify(card);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(droppedProgress).toBeGreaterThan(0);
    // 守住回归: 若用 .length 量, 这张卡会被判为“未超限”而不裁
    expect(json.length).toBeLessThan(MAX_CARD_BYTES);
  });

  it('failed 状态渲染红色标题', () => {
    const { card } = renderCard({
      progress: [],
      answer: '调用超时了',
      failed: true,
    }) as { card: any };
    expect(card.header.template).toBe('red');
  });
});
```

- [ ] **Step 2: 写 tests/feishu/stream-card.test.ts（失败的测试）**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStreamCard } from '../../src/feishu/stream-card';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const target = {
  chatId: 'oc_1',
  messageId: 'om_1',
  chatType: 'group' as const,
};

const makeApi = () => ({
  sendMessage: vi.fn().mockResolvedValue('om_card_send'),
  replyMessage: vi.fn().mockResolvedValue('om_card_reply'),
  patchMessage: vi.fn().mockResolvedValue(undefined),
  createReaction: vi.fn(),
  getBotOpenId: vi.fn(),
});

describe('openStreamCard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('群聊用引用回复建卡, 首帧是思考中', async () => {
    const api = makeApi();
    await openStreamCard({ api, logger: logger as never, throttleMs: 500 }, target);

    expect(api.replyMessage).toHaveBeenCalledTimes(1);
    const arg = api.replyMessage.mock.calls[0][0];
    expect(arg.msgType).toBe('interactive');
    expect(arg.content).toContain('💭 思考中');
  });

  it('私聊用直发建卡', async () => {
    const api = makeApi();
    await openStreamCard({ api, logger: logger as never, throttleMs: 500 }, {
      ...target,
      chatType: 'p2p',
    });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.replyMessage).not.toHaveBeenCalled();
  });

  it('进度行按节流合并成一次 patch', async () => {
    const api = makeApi();
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    card.addProgress('📖 Read a.ts');
    card.addProgress('🔧 Bash npm test');
    expect(api.patchMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(api.patchMessage).toHaveBeenCalledTimes(1);
    expect(api.patchMessage.mock.calls[0][0].content).toContain('🔧 Bash npm test');
  });

  it('finalize 立即冲刷并 patch 成终态答案', async () => {
    const api = makeApi();
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    card.addProgress('📖 Read a.ts');
    await card.finalize('这是最终答案');

    const last = api.patchMessage.mock.calls.at(-1)![0];
    expect(last.messageId).toBe('om_card_reply');
    expect(last.content).toContain('这是最终答案');
    expect(last.content).not.toContain('💭 思考中');
  });

  it('finalize 后再 addProgress 不再发请求', async () => {
    const api = makeApi();
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    await card.finalize('done');
    const count = api.patchMessage.mock.calls.length;

    card.addProgress('📖 Read late.ts');
    await vi.advanceTimersByTimeAsync(500);
    expect(api.patchMessage).toHaveBeenCalledTimes(count);
  });

  it('patch 连续 3 次失败后发新卡片续传, 内容不丢', async () => {
    const api = makeApi();
    api.patchMessage.mockRejectedValue(new Error('230099'));
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    for (let i = 0; i < 3; i += 1) {
      card.addProgress(`🔧 step ${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }

    // 第 3 次失败后补发新卡片
    expect(api.replyMessage).toHaveBeenCalledTimes(2);
    expect(api.replyMessage.mock.calls[1][0].content).toContain('🔧 step 2');
  });

  it('patch 成功会重置失败计数', async () => {
    const api = makeApi();
    api.patchMessage
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'));
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    for (let i = 0; i < 4; i += 1) {
      card.addProgress(`🔧 step ${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(api.replyMessage).toHaveBeenCalledTimes(1);
  });

  it('fail 渲染红色终态卡片', async () => {
    const api = makeApi();
    const card = await openStreamCard(
      { api, logger: logger as never, throttleMs: 500 },
      target,
    );

    await card.fail('调用超时了');
    const last = api.patchMessage.mock.calls.at(-1)![0];
    expect(last.content).toContain('调用超时了');
    expect(last.content).toContain('"red"');
  });

  it('建卡失败时把错误抛给调用方 (由调用方降级为纯文本)', async () => {
    const api = makeApi();
    api.replyMessage.mockRejectedValue(new Error('card rejected'));

    await expect(
      openStreamCard({ api, logger: logger as never, throttleMs: 500 }, target),
    ).rejects.toThrow('card rejected');
  });
});
```

- [ ] **Step 3: 运行两个测试确认失败**

Run: `npx vitest run tests/feishu/stream-card-render.test.ts tests/feishu/stream-card.test.ts`
Expected: FAIL，两个文件都报 `Failed to resolve import`

- [ ] **Step 4: 写 src/feishu/stream-card-render.ts**

```ts
import { toCardMarkdown } from './markdown';

/** 整张卡片 JSON 的硬限 (spec: 卡片 30KB)。 */
export const MAX_CARD_BYTES = 30_000;

const THINKING = '💭 思考中…';

export interface CardState {
  /** 工具调用进度行, 按发生顺序。 */
  progress: string[];
  /** 终态答案; 空串表示仍在思考。 */
  answer: string;
  /** 失败终态, 渲染红色标题。 */
  failed: boolean;
}

function build(state: CardState, progress: string[]): object {
  const elements: object[] = [
    {
      tag: 'markdown',
      content: state.answer ? toCardMarkdown(state.answer) : THINKING,
    },
  ];

  if (progress.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: progress.join('\n') });
  }

  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'agentlark' },
      template: state.failed ? 'red' : 'blue',
    },
    body: { elements },
  };
}

/**
 * 纯函数: 状态 → 卡片 JSON。超过 30KB 时从最早的进度行开始裁,
 * 保证「最新进度 + 答案」永远留得下 (答案本身由 markdown 硬限收敛)。
 *
 * 用 Buffer.byteLength(..., 'utf8') 而不是 String.length: spec 的 30KB 是字节口径,
 * 而 .length 数的是 UTF-16 码元 —— 中文/emoji 一个字符占 3+ 字节却只算 1,
 * 用 .length 量会让闸门少算最多 3 倍, 卡片超限被飞书拒收后 patch 连续失败,
 * 续传的新卡同样超限, 内容彻底卡死。
 */
export function renderCard(state: CardState): {
  card: object;
  droppedProgress: number;
} {
  let progress = state.progress;
  let card = build(state, progress);
  let dropped = 0;

  while (
    Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_CARD_BYTES &&
    progress.length > 0
  ) {
    // 每轮至少裁一行, 行数多时按比例加速收敛
    const cut = Math.max(1, Math.floor(progress.length / 4));
    progress = progress.slice(cut);
    dropped += cut;
    card = build(state, progress);
  }

  return { card, droppedProgress: dropped };
}
```

- [ ] **Step 5: 写 src/feishu/stream-card.ts**

```ts
import type { Logger } from '../infra/logger';
import { createThrottle } from '../infra/throttle';
import type { FeishuApi } from './client';
import { type CardState, renderCard } from './stream-card-render';

/** patch 连续失败多少次后改发新卡片续传。 */
export const MAX_PATCH_FAILURES = 3;

export interface StreamCardDeps {
  api: FeishuApi;
  logger: Logger;
  throttleMs: number;
}

export interface StreamCardTarget {
  chatId: string;
  messageId: string;
  chatType: 'p2p' | 'group';
}

export interface StreamCardHandle {
  /** 追加一条工具调用进度行 (节流刷新)。 */
  addProgress(line: string): void;
  /** 终态: 把卡片 patch 成完整答案。 */
  finalize(text: string): Promise<void>;
  /** 失败终态: 红色卡片 + 可读错误。 */
  fail(text: string): Promise<void>;
}

/**
 * 建一张「💭 思考中」卡片并返回句柄。
 * 建卡失败会把错误抛给调用方 —— 调用方负责降级成纯文本回复。
 */
export async function openStreamCard(
  deps: StreamCardDeps,
  target: StreamCardTarget,
): Promise<StreamCardHandle> {
  const state: CardState = { progress: [], answer: '', failed: false };

  const sendCard = async (): Promise<string> => {
    const content = JSON.stringify(renderCard(state).card);
    return target.chatType === 'group'
      ? deps.api.replyMessage({
          messageId: target.messageId,
          msgType: 'interactive',
          content,
        })
      : deps.api.sendMessage({
          chatId: target.chatId,
          msgType: 'interactive',
          content,
        });
  };

  let cardMessageId = await sendCard();
  let consecutiveFailures = 0;
  let closed = false;

  const flushOnce = async (): Promise<void> => {
    const content = JSON.stringify(renderCard(state).card);
    try {
      await deps.api.patchMessage({ messageId: cardMessageId, content });
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      deps.logger.warn(
        { err: error, cardMessageId, consecutiveFailures },
        'stream-card: patch failed',
      );

      if (consecutiveFailures >= MAX_PATCH_FAILURES) {
        try {
          cardMessageId = await sendCard();
          consecutiveFailures = 0;
          deps.logger.info(
            { cardMessageId },
            'stream-card: continued on a new card',
          );
        } catch (resendError) {
          deps.logger.error(
            { err: resendError },
            'stream-card: resend failed, content dropped',
          );
          consecutiveFailures = 0;
        }
      }
    }
  };

  const throttled = createThrottle<null>(deps.throttleMs, flushOnce);

  const settle = async (text: string, failed: boolean): Promise<void> => {
    state.answer = text;
    state.failed = failed;
    closed = true;
    await throttled.flush();
    await flushOnce();
  };

  return {
    addProgress(line: string): void {
      if (closed) return;
      state.progress.push(line);
      throttled.push(null);
    },
    finalize(text: string): Promise<void> {
      return settle(text, false);
    },
    fail(text: string): Promise<void> {
      return settle(text, true);
    },
  };
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/feishu/stream-card-render.test.ts tests/feishu/stream-card.test.ts`
Expected: PASS（17 个用例）

- [ ] **Step 7: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 8: 提交**

```bash
git add src/feishu/stream-card-render.ts src/feishu/stream-card.ts tests/feishu/stream-card-render.test.ts tests/feishu/stream-card.test.ts
git commit -m "feat: 流式卡片 (节流刷新/30KB 裁剪/patch 失败续传)"
```

---

### Task 9: claude 子进程 argv 与 env 白名单

**Files:**
- Create: `src/agent/args.ts`, `src/agent/child-env.ts`
- Test: `tests/agent/args.test.ts`, `tests/agent/child-env.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface AgentArgsInput { model: string; permissionMode: string; resumeSessionId?: string }`
  - `buildAgentArgs(input: AgentArgsInput): string[]`
  - `CHILD_ENV_ALLOWLIST: readonly string[]`
  - `buildChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv`

- [ ] **Step 1: 写 tests/agent/args.test.ts（失败的测试）**

```ts
import { describe, expect, it } from 'vitest';
import { buildAgentArgs } from '../../src/agent/args';

describe('buildAgentArgs', () => {
  it('总是以 headless + stream-json 模式运行', () => {
    const args = buildAgentArgs({ model: '', permissionMode: 'bypassPermissions' });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('prompt 不进 argv (改走 stdin, 避免超长与转义问题)', () => {
    const args = buildAgentArgs({ model: '', permissionMode: 'default' });
    expect(args.some((a) => a.includes('帮我'))).toBe(false);
  });

  it('AGENT_MODEL 为空时不传 --model, 由 ~/.claude/settings.json 决定', () => {
    const args = buildAgentArgs({ model: '', permissionMode: 'default' });
    expect(args).not.toContain('--model');
  });

  it('配置了模型时传 --model', () => {
    const args = buildAgentArgs({
      model: 'claude-opus-5',
      permissionMode: 'default',
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5');
  });

  it('有 sessionId 时续接会话', () => {
    const args = buildAgentArgs({
      model: '',
      permissionMode: 'default',
      resumeSessionId: 'sess_abc',
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess_abc');
  });

  it('没有 sessionId 时不传 --resume', () => {
    expect(
      buildAgentArgs({ model: '', permissionMode: 'default' }),
    ).not.toContain('--resume');
  });
});
```

- [ ] **Step 2: 写 tests/agent/child-env.test.ts（失败的测试）**

```ts
import { describe, expect, it } from 'vitest';
import { buildChildEnv } from '../../src/agent/child-env';

describe('buildChildEnv', () => {
  it('保留白名单内的变量', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', HOME: '/Users/me' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/me');
  });

  it('剔除飞书凭据等敏感变量', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      FEISHU_APP_SECRET: 'secret',
      FEISHU_APP_ID: 'cli_x',
      SENSORS_COOKIE: 'c',
      AWS_SECRET_ACCESS_KEY: 'k',
    });
    expect(env.FEISHU_APP_SECRET).toBeUndefined();
    expect(env.FEISHU_APP_ID).toBeUndefined();
    expect(env.SENSORS_COOKIE).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('剔除未列入白名单的任意变量', () => {
    expect(buildChildEnv({ PATH: '/usr/bin', RANDOM_THING: 'x' }).RANDOM_THING)
      .toBeUndefined();
  });

  it('白名单里未设置的变量不会凭空出现', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' });
    expect('TMPDIR' in env).toBe(false);
  });
});
```

- [ ] **Step 3: 运行两个测试确认失败**

Run: `npx vitest run tests/agent/args.test.ts tests/agent/child-env.test.ts`
Expected: FAIL，两个文件都报 `Failed to resolve import`

- [ ] **Step 4: 写 src/agent/args.ts**

```ts
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
```

- [ ] **Step 5: 写 src/agent/child-env.ts**

```ts
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
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/agent/args.test.ts tests/agent/child-env.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 7: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 8: 提交**

```bash
git add src/agent/args.ts src/agent/child-env.ts tests/agent/args.test.ts tests/agent/child-env.test.ts
git commit -m "feat: claude 子进程 argv 拼装与 env 白名单收敛"
```

---

### Task 10: stream-json 输出解析与工具进度行

**Files:**
- Create: `src/types/agent.ts`, `src/agent/tool-label.ts`, `src/agent/stream-parser.ts`
- Test: `tests/agent/tool-label.test.ts`, `tests/agent/stream-parser.test.ts`

**背景（实现者必读）：** `claude -p --output-format stream-json --verbose` 往 stdout 逐行吐 NDJSON。Plan 1 只需要认这四种行：

```jsonc
{"type":"system","subtype":"init","session_id":"sess_abc","tools":[...]}
{"type":"assistant","message":{"content":[{"type":"text","text":"部分答案"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a/b.ts"}}]}}
{"type":"result","subtype":"success","is_error":false,"result":"完整答案","session_id":"sess_abc"}
```

认不出的行一律忽略（不同 CLI 版本会加新事件，忽略未知类型比崩掉好）。

**Interfaces:**
- Consumes: 无
- Produces:
  - `type AgentEvent = { type: 'session'; sessionId: string } | { type: 'tool'; line: string } | { type: 'text'; text: string } | { type: 'result'; ok: boolean; text: string; sessionId: string }`
  - `interface AgentResult { ok: boolean; text: string; sessionId: string }`
  - `formatToolLine(name: string, input: unknown): string`
  - `createStreamParser(onEvent: (event: AgentEvent) => void): { write(chunk: string): void; end(): void }`

- [ ] **Step 1: 写 tests/agent/tool-label.test.ts（失败的测试）**

```ts
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
    expect(line).toBe(`\u{1f527} Bash \`${'x'.repeat(60)}\u2026\``);
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
```

- [ ] **Step 2: 写 tests/agent/stream-parser.test.ts（失败的测试）**

```ts
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
```

- [ ] **Step 3: 运行两个测试确认失败**

Run: `npx vitest run tests/agent/tool-label.test.ts tests/agent/stream-parser.test.ts`
Expected: FAIL，两个文件都报 `Failed to resolve import`

- [ ] **Step 4: 写 src/types/agent.ts**

```ts
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'tool'; line: string }
  | { type: 'text'; text: string }
  | { type: 'result'; ok: boolean; text: string; sessionId: string };

export interface AgentResult {
  ok: boolean;
  /** 给用户看的正文 (成功是答案, 失败是可读的失败原因)。 */
  text: string;
  /** 本轮 claude 会话 id; 空串表示没解析到, 不要写进 session store。 */
  sessionId: string;
}

export interface RunAgentInput {
  prompt: string;
  resumeSessionId?: string;
}

export type RunAgent = (
  input: RunAgentInput,
  onEvent: (event: AgentEvent) => void,
) => Promise<AgentResult>;
```

- [ ] **Step 5: 写 src/agent/tool-label.ts**

```ts
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
```

- [ ] **Step 6: 写 src/agent/stream-parser.ts**

```ts
import type { AgentEvent } from '../types/agent';
import { formatToolLine } from './tool-label';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export interface StreamParser {
  /** 喂一段 stdout; 内部按行缓冲, 半行会留到下次。 */
  write(chunk: string): void;
  /** stdout 结束时调用, 冲刷没有结尾换行的最后一行。 */
  end(): void;
}

/**
 * 解析 claude --output-format stream-json 的 NDJSON 输出。
 * 认不出的行 (非 JSON / 未知 type) 一律忽略 —— CLI 升级加新事件时不能把 bot 打挂。
 */
export function createStreamParser(
  onEvent: (event: AgentEvent) => void,
): StreamParser {
  let buffer = '';

  const emit = (event: AgentEvent): void => {
    try {
      onEvent(event);
    } catch {
      // 回调是渲染侧的事; 渲染失败不该中断解析
    }
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let payload: Record<string, unknown> | null;
    try {
      payload = asRecord(JSON.parse(trimmed));
    } catch {
      return;
    }
    if (!payload) return;

    switch (str(payload.type)) {
      case 'system': {
        const sessionId = str(payload.session_id);
        if (str(payload.subtype) === 'init' && sessionId) {
          emit({ type: 'session', sessionId });
        }
        return;
      }

      case 'assistant': {
        const content = asRecord(payload.message)?.content;
        if (!Array.isArray(content)) return;
        for (const raw of content) {
          const block = asRecord(raw);
          if (!block) continue;
          const blockType = str(block.type);
          if (blockType === 'text') {
            const text = str(block.text);
            if (text) emit({ type: 'text', text });
          } else if (blockType === 'tool_use') {
            const name = str(block.name);
            if (name) emit({ type: 'tool', line: formatToolLine(name, block.input) });
          }
        }
        return;
      }

      case 'result': {
        emit({
          type: 'result',
          ok: payload.is_error !== true,
          text: str(payload.result),
          sessionId: str(payload.session_id),
        });
        return;
      }

      default:
        return;
    }
  };

  return {
    write(chunk: string): void {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    },
    end(): void {
      if (buffer.length > 0) {
        const rest = buffer;
        buffer = '';
        handleLine(rest);
      }
    },
  };
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/agent/tool-label.test.ts tests/agent/stream-parser.test.ts`
Expected: PASS（20 个用例）

- [ ] **Step 8: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 9: 提交**

```bash
git add src/types/agent.ts src/agent/tool-label.ts src/agent/stream-parser.ts tests/agent/tool-label.test.ts tests/agent/stream-parser.test.ts
git commit -m "feat: stream-json 输出解析与工具调用进度行"
```

---

### Task 11: claude 子进程流式执行器

**Files:**
- Create: `src/agent/stream-runner.ts`
- Test: `tests/agent/stream-runner.test.ts`

**Interfaces:**
- Consumes: `buildAgentArgs`（Task 9）、`buildChildEnv`（Task 9）、`createStreamParser`（Task 10）、`AgentEvent` / `AgentResult` / `RunAgent` / `RunAgentInput`（Task 10）、`Logger`（Task 2）
- Produces:
  - `interface AgentRunnerDeps { bin: string; model: string; permissionMode: string; timeoutMs: number; cwd: string; logger: Logger; spawnFn?: SpawnFn }`
  - `type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessLike`
  - `interface ChildProcessLike { stdout: EventEmitter; stderr: EventEmitter; stdin: { write(data: string): void; end(): void }; on(event: 'close' | 'error', listener: (...args: any[]) => void): void; kill(signal?: NodeJS.Signals): boolean }`
  - `createAgentRunner(deps: AgentRunnerDeps): RunAgent`

- [ ] **Step 1: 写 tests/agent/stream-runner.test.ts（失败的测试）**

```ts
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentRunner } from '../../src/agent/stream-runner';
import type { AgentEvent } from '../../src/types/agent';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  kill = vi.fn(() => true);

  emitLine(payload: unknown): void {
    this.stdout.emit('data', JSON.stringify(payload) + '\n');
  }
}

const makeRunner = (child: FakeChild, overrides = {}) => {
  // 用 mockReturnValue 而不是 vi.fn(() => child): 后者会把调用签名推成零参,
  // 让 spawnFn.mock.calls[0][1] 过不了 tsc --noEmit
  const spawnFn = vi.fn().mockReturnValue(child);
  const run = createAgentRunner({
    bin: 'claude',
    model: '',
    permissionMode: 'bypassPermissions',
    timeoutMs: 5000,
    cwd: '/workspace',
    logger: logger as never,
    spawnFn: spawnFn as never,
    ...overrides,
  });
  return { run, spawnFn };
};

describe('createAgentRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('把 prompt 写进 stdin 而不是 argv', async () => {
    const child = new FakeChild();
    const { run, spawnFn } = makeRunner(child);

    const promise = run({ prompt: '帮我查一下 PV' }, () => {});
    expect(child.stdin.write).toHaveBeenCalledWith('帮我查一下 PV');
    expect(child.stdin.end).toHaveBeenCalled();
    expect(spawnFn.mock.calls[0][1]).not.toContain('帮我查一下 PV');

    child.emitLine({
      type: 'result',
      is_error: false,
      result: 'ok',
      session_id: 's1',
    });
    child.emit('close', 0);
    await promise;
  });

  it('spawn 用配置的 bin、cwd 与白名单 env', async () => {
    const child = new FakeChild();
    const { run, spawnFn } = makeRunner(child);

    const promise = run({ prompt: 'hi' }, () => {});
    const [command, , options] = spawnFn.mock.calls[0] as [string, string[], any];
    expect(command).toBe('claude');
    expect(options.cwd).toBe('/workspace');
    expect(options.env.FEISHU_APP_SECRET).toBeUndefined();

    child.emit('close', 0);
    await promise;
  });

  it('有 resumeSessionId 时传 --resume', async () => {
    const child = new FakeChild();
    const { run, spawnFn } = makeRunner(child);

    const promise = run({ prompt: 'hi', resumeSessionId: 'sess_old' }, () => {});
    expect(spawnFn.mock.calls[0][1]).toContain('--resume');
    child.emit('close', 0);
    await promise;
  });

  it('把解析出的事件回调给调用方并返回终态结果', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child);
    const events: AgentEvent[] = [];

    const promise = run({ prompt: 'hi' }, (e) => events.push(e));
    child.emitLine({ type: 'system', subtype: 'init', session_id: 'sess_new' });
    child.emitLine({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }],
      },
    });
    child.emitLine({
      type: 'result',
      is_error: false,
      result: '答案在这里',
      session_id: 'sess_new',
    });
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({
      ok: true,
      text: '答案在这里',
      sessionId: 'sess_new',
    });
    expect(events).toEqual([
      { type: 'session', sessionId: 'sess_new' },
      { type: 'tool', line: '📖 Read a.ts' },
      {
        type: 'result',
        ok: true,
        text: '答案在这里',
        sessionId: 'sess_new',
      },
    ]);
  });

  it('没有 result 行但退出码为 0 时回退到累积的文本', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child);

    const promise = run({ prompt: 'hi' }, () => {});
    child.emitLine({ type: 'system', subtype: 'init', session_id: 'sess_a' });
    child.emitLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '拼接答案' }] },
    });
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({
      ok: true,
      text: '拼接答案',
      sessionId: 'sess_a',
    });
  });

  it('非零退出码且无 result 时返回失败与 stderr 尾巴', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child);

    const promise = run({ prompt: 'hi' }, () => {});
    child.stderr.emit('data', 'fatal: model unavailable\n');
    child.emit('close', 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.text).toContain('model unavailable');
  });

  it('spawn ENOENT 转成可读失败, 不抛错', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child);

    const promise = run({ prompt: 'hi' }, () => {});
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    }));

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.text).toContain('AGENT_BIN');
  });

  it('超时后 kill 子进程并返回超时提示', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child, { timeoutMs: 1000 });

    const promise = run({ prompt: 'hi' }, () => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.text).toContain('超时');
  });

  it('超时后子进程赖着不走会补 SIGKILL', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child, { timeoutMs: 1000 });

    const promise = run({ prompt: 'hi' }, () => {});
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toMatchObject({ ok: false });

    await vi.advanceTimersByTimeAsync(3000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('正常结束后清掉超时定时器, 不会二次 kill', async () => {
    const child = new FakeChild();
    const { run } = makeRunner(child, { timeoutMs: 1000 });

    const promise = run({ prompt: 'hi' }, () => {});
    child.emitLine({
      type: 'result',
      is_error: false,
      result: 'ok',
      session_id: 's',
    });
    child.emit('close', 0);
    await promise;

    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/agent/stream-runner.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/agent/stream-runner"`

- [ ] **Step 3: 写 src/agent/stream-runner.ts**

```ts
import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Logger } from '../infra/logger';
import type {
  AgentEvent,
  AgentResult,
  RunAgent,
  RunAgentInput,
} from '../types/agent';
import { buildAgentArgs } from './args';
import { buildChildEnv } from './child-env';
import { createStreamParser } from './stream-parser';

/** 超时 SIGTERM 后再等多久补 SIGKILL。 */
const KILL_GRACE_MS = 3000;
/** 失败时附带的 stderr 尾巴长度。 */
const STDERR_TAIL = 600;

export interface ChildProcessLike {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write(data: string): void; end(): void };
  on(event: 'close' | 'error', listener: (...args: any[]) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcessLike;

export interface AgentRunnerDeps {
  bin: string;
  model: string;
  permissionMode: string;
  timeoutMs: number;
  cwd: string;
  logger: Logger;
  /** 测试注入假实现。 */
  spawnFn?: SpawnFn;
}

/**
 * spawn claude headless 子进程, 边跑边把事件回调出去, 结束返回终态。
 * 永远 resolve, 不 reject —— 失败也是一条要发给用户的可读消息。
 */
export function createAgentRunner(deps: AgentRunnerDeps): RunAgent {
  const spawnFn: SpawnFn = deps.spawnFn ?? (spawn as unknown as SpawnFn);

  return (input: RunAgentInput, onEvent: (event: AgentEvent) => void) =>
    new Promise<AgentResult>((resolve) => {
      const args = buildAgentArgs({
        model: deps.model,
        permissionMode: deps.permissionMode,
        resumeSessionId: input.resumeSessionId,
      });

      let sessionId = input.resumeSessionId ?? '';
      let finalResult: AgentResult | null = null;
      let streamedText = '';
      let stderrTail = '';
      let settled = false;

      const parser = createStreamParser((event) => {
        if (event.type === 'session') sessionId = event.sessionId;
        if (event.type === 'text') streamedText += event.text;
        if (event.type === 'result') {
          if (event.sessionId) sessionId = event.sessionId;
          finalResult = {
            ok: event.ok,
            text: event.text,
            sessionId: event.sessionId || sessionId,
          };
        }
        onEvent(event);
      });

      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (result: AgentResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        resolve(result);
      };

      let child: ChildProcessLike;
      try {
        child = spawnFn(deps.bin, args, {
          cwd: deps.cwd,
          env: buildChildEnv(process.env),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        deps.logger.error({ err: error, bin: deps.bin }, 'agent: spawn threw');
        settle({
          ok: false,
          text: `启动模型失败: 找不到可执行文件 \`${deps.bin}\`。请用 \`which claude\` 拿到绝对路径写进 AGENT_BIN。`,
          sessionId,
        });
        return;
      }

      // 超时立刻给用户答复, 不等子进程真的退出 —— 卡死的子进程不该把用户一起卡住。
      // SIGKILL 兜底定时器刻意不随 settle 清掉, 保证进程一定被回收。
      timeoutTimer = setTimeout(() => {
        deps.logger.warn(
          { timeoutMs: deps.timeoutMs },
          'agent: timed out, sending SIGTERM',
        );
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        settle({
          ok: false,
          text: `模型调用超时 (${Math.round(deps.timeoutMs / 1000)} 秒)。可以拆成更小的问题再问一次, 或调大 AGENT_TIMEOUT_MS。`,
          sessionId,
        });
      }, deps.timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        parser.write(chunk.toString());
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL);
      });

      child.on('error', (error: Error) => {
        deps.logger.error({ err: error, bin: deps.bin }, 'agent: spawn failed');
        settle({
          ok: false,
          text: `启动模型失败: \`${deps.bin}\` 无法执行 (${error.message})。请用 \`which claude\` 拿到绝对路径写进 AGENT_BIN。`,
          sessionId,
        });
      });

      child.on('close', (code: number | null) => {
        if (killTimer !== null) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        parser.end();
        if (settled) return;

        if (finalResult) {
          settle(finalResult);
          return;
        }

        if (code === 0 && streamedText.trim().length > 0) {
          settle({ ok: true, text: streamedText, sessionId });
          return;
        }

        deps.logger.error(
          { code, stderrTail },
          'agent: exited without a result line',
        );
        const detail = stderrTail.trim();
        settle({
          ok: false,
          text: detail
            ? `模型执行失败 (退出码 ${code}):\n\`\`\`\n${detail}\n\`\`\``
            : `模型执行失败 (退出码 ${code}), 且没有输出。详见 runtime/logs/bot.log。`,
          sessionId,
        });
      });

      child.stdin.write(input.prompt);
      child.stdin.end();
    });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/agent/stream-runner.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 6: 提交**

```bash
git add src/agent/stream-runner.ts tests/agent/stream-runner.test.ts
git commit -m "feat: claude 子进程流式执行器 (超时/kill/失败可读化)"
```

---

### Task 12: 会话持久化（sessions.json + 24 小时空闲过期）

**Files:**
- Create: `src/agent/session-store.ts`
- Test: `tests/agent/session-store.test.ts`

**Interfaces:**
- Consumes: `ParsedMessage`（Task 3）
- Produces:
  - `SESSIONS_FILE: string`（= `<cwd>/user-data/runtime/sessions.json`）
  - `sessionKey(msg: ParsedMessage): string`（私聊按人 `p2p:<openId>`，群聊按群 `group:<chatId>`）
  - `interface SessionStore { get(key: string): string | undefined; set(key: string, sessionId: string): void; clear(key: string): void }`
  - `createSessionStore(opts: { file: string; maxIdleHours: number; now?: () => number }): SessionStore`

- [ ] **Step 1: 写 tests/agent/session-store.test.ts（失败的测试）**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/agent/session-store.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/agent/session-store"`

- [ ] **Step 3: 写 src/agent/session-store.ts**

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ParsedMessage } from '../types/feishu';

/** spec 规定的落点; 注意与 runtime/ 是两个不同目录, 不要合并。 */
export const SESSIONS_FILE = resolve(
  process.cwd(),
  'user-data/runtime/sessions.json',
);

/** 会话维度: 私聊按人, 群聊按群。 */
export function sessionKey(msg: ParsedMessage): string {
  return msg.chatType === 'p2p'
    ? `p2p:${msg.senderOpenId}`
    : `group:${msg.chatId}`;
}

interface SessionRecord {
  sessionId: string;
  updatedAt: number;
}

export interface SessionStore {
  /** 返回可用于 --resume 的 sessionId; 不存在或已过期返回 undefined。 */
  get(key: string): string | undefined;
  set(key: string, sessionId: string): void;
  clear(key: string): void;
}

const isRecord = (value: unknown): value is SessionRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as SessionRecord).sessionId === 'string' &&
  typeof (value as SessionRecord).updatedAt === 'number';

function load(file: string): Map<string, SessionRecord> {
  const map = new Map<string, SessionRecord>();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return map;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return map;
    for (const [key, value] of Object.entries(parsed)) {
      if (isRecord(value)) map.set(key, value);
    }
  } catch {
    // 文件损坏时当作空的重新开始; 代价只是丢一轮上下文
  }
  return map;
}

/** 原子写: 先写临时文件再 rename, 避免崩在半截留下坏文件。 */
function persist(file: string, map: Map<string, SessionRecord>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
  renameSync(tmp, file);
}

export function createSessionStore(opts: {
  file: string;
  /** 0 表示不过期。 */
  maxIdleHours: number;
  now?: () => number;
}): SessionStore {
  const now = opts.now ?? (() => Date.now());
  const map = load(opts.file);
  const maxIdleMs = opts.maxIdleHours * 3600_000;

  return {
    get(key) {
      const record = map.get(key);
      if (!record) return undefined;

      if (maxIdleMs > 0 && now() - record.updatedAt > maxIdleMs) {
        map.delete(key);
        persist(opts.file, map);
        return undefined;
      }
      return record.sessionId;
    },

    set(key, sessionId) {
      if (!sessionId) return;
      map.set(key, { sessionId, updatedAt: now() });
      persist(opts.file, map);
    },

    clear(key) {
      if (map.delete(key)) persist(opts.file, map);
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/agent/session-store.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 5: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 6: 提交**

```bash
git add src/agent/session-store.ts tests/agent/session-store.test.ts
git commit -m "feat: 会话持久化与 24 小时空闲过期"
```

---

### Task 13: 主流水线编排

**Files:**
- Create: `src/handler/message.ts`
- Test: `tests/handler/message.test.ts`

**背景（实现者必读）：** 本模块**只做编排**，一行 IO 都不许直接写——飞书 API、spawn、落盘全部通过 `MessagePipelineDeps` 注入。Plan 1 的 prompt 就是用户原话（`msg.text`）；系统头、仓库挂载、Wiki 检索指引是 Plan 2 的事，**不要提前加**。

**Interfaces:**
- Consumes: `ParsedMessage`（Task 3）、`matchCommand` / `RESET_REPLY` / `WHOAMI_GROUP_HINT`（Task 5）、`Replier`（Task 7）、`StreamCardHandle` / `StreamCardTarget`（Task 8）、`RunAgent`（Task 10）、`SessionStore` / `sessionKey`（Task 12）、`Logger`（Task 2）
- Produces:
  - `interface MessagePipelineDeps { sessions: SessionStore; runAgent: RunAgent; openCard: (target: StreamCardTarget) => Promise<StreamCardHandle>; reply: Replier; react: (messageId: string) => Promise<void>; logger: Logger }`
  - `createMessagePipeline(deps: MessagePipelineDeps): (msg: ParsedMessage) => Promise<void>`

- [ ] **Step 1: 写 tests/handler/message.test.ts（失败的测试）**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createMessagePipeline } from '../../src/handler/message';
import type { ParsedMessage } from '../../src/types/feishu';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const msg = (overrides: Partial<ParsedMessage> = {}): ParsedMessage => ({
  messageId: 'om_1',
  rootId: '',
  parentId: '',
  chatId: 'oc_1',
  chatType: 'p2p',
  senderOpenId: 'ou_sender',
  text: '帮我查一下昨天的 PV',
  mentions: [],
  mentionsAll: false,
  createTimeMs: 0,
  ...overrides,
});

const makeDeps = (overrides: Record<string, unknown> = {}) => {
  const card = {
    addProgress: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  };
  const sessions = {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    clear: vi.fn(),
  };
  const deps = {
    sessions,
    runAgent: vi.fn().mockResolvedValue({
      ok: true,
      text: '昨天 PV 是 12345',
      sessionId: 'sess_new',
    }),
    openCard: vi.fn().mockResolvedValue(card),
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
    logger: logger as never,
    ...overrides,
  };
  return { deps, card, sessions };
};

describe('createMessagePipeline', () => {
  it('收到消息先点 Typing 表情', async () => {
    const { deps } = makeDeps();
    await createMessagePipeline(deps as never)(msg());
    expect(deps.react).toHaveBeenCalledWith('om_1');
  });

  it('/new 清空会话并纯文本直答, 不启动模型', async () => {
    const { deps, sessions } = makeDeps();
    await createMessagePipeline(deps as never)(msg({ text: '/new' }));

    expect(sessions.clear).toHaveBeenCalledWith('p2p:ou_sender');
    expect(deps.reply).toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.openCard).not.toHaveBeenCalled();
  });

  it('私聊 /whoami 回显 open_id', async () => {
    const { deps } = makeDeps();
    await createMessagePipeline(deps as never)(msg({ text: '/whoami' }));

    expect(deps.reply.mock.calls[0][1]).toContain('ou_sender');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('群聊 /whoami 提示去私聊', async () => {
    const { deps } = makeDeps();
    await createMessagePipeline(deps as never)(
      msg({ text: '/whoami', chatType: 'group' }),
    );

    expect(deps.reply.mock.calls[0][1]).toContain('私聊');
    expect(deps.reply.mock.calls[0][1]).not.toContain('ou_sender');
  });

  it('固定直答走纯文本, 不启动模型', async () => {
    const { deps } = makeDeps();
    await createMessagePipeline(deps as never)(msg({ text: '你好' }));

    expect(deps.reply).toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('普通提问建卡 + 跑模型 + 终态 patch', async () => {
    const { deps, card } = makeDeps();
    await createMessagePipeline(deps as never)(msg());

    expect(deps.openCard).toHaveBeenCalledWith({
      chatId: 'oc_1',
      messageId: 'om_1',
      chatType: 'p2p',
    });
    expect(deps.runAgent.mock.calls[0][0]).toEqual({
      prompt: '帮我查一下昨天的 PV',
      resumeSessionId: undefined,
    });
    expect(card.finalize).toHaveBeenCalledWith('昨天 PV 是 12345');
  });

  it('有历史会话时带上 --resume 的 sessionId', async () => {
    const { deps, sessions } = makeDeps();
    sessions.get.mockReturnValue('sess_old');
    await createMessagePipeline(deps as never)(msg());

    expect(deps.runAgent.mock.calls[0][0].resumeSessionId).toBe('sess_old');
  });

  it('工具调用事件实时刷到卡片进度上', async () => {
    const { deps, card } = makeDeps({
      runAgent: vi.fn(async (_input: unknown, onEvent: (e: unknown) => void) => {
        onEvent({ type: 'tool', line: '📖 Read a.ts' });
        onEvent({ type: 'text', text: '中间输出' });
        return { ok: true, text: '答案', sessionId: 'sess_new' };
      }),
    });
    await createMessagePipeline(deps as never)(msg());

    expect(card.addProgress).toHaveBeenCalledWith('📖 Read a.ts');
    expect(card.addProgress).toHaveBeenCalledTimes(1);
  });

  it('成功后固化 sessionId', async () => {
    const { deps, sessions } = makeDeps();
    await createMessagePipeline(deps as never)(msg());
    expect(sessions.set).toHaveBeenCalledWith('p2p:ou_sender', 'sess_new');
  });

  it('模型返回失败时用红色卡片展示, 且不固化 sessionId', async () => {
    const { deps, card, sessions } = makeDeps({
      runAgent: vi.fn().mockResolvedValue({
        ok: false,
        text: '模型调用超时',
        sessionId: 'sess_new',
      }),
    });
    await createMessagePipeline(deps as never)(msg());

    expect(card.fail).toHaveBeenCalledWith('模型调用超时');
    expect(card.finalize).not.toHaveBeenCalled();
    expect(sessions.set).not.toHaveBeenCalled();
  });

  it('建卡失败时降级为纯文本回复, 仍然跑模型', async () => {
    const { deps } = makeDeps({
      openCard: vi.fn().mockRejectedValue(new Error('card rejected')),
    });
    await createMessagePipeline(deps as never)(msg());

    expect(deps.runAgent).toHaveBeenCalled();
    expect(deps.reply.mock.calls.at(-1)![1]).toBe('昨天 PV 是 12345');
  });

  it('runAgent 意外抛错转成用户可读的失败卡片, 不向上抛', async () => {
    const { deps, card } = makeDeps({
      runAgent: vi.fn().mockRejectedValue(new Error('unexpected')),
    });

    await expect(
      createMessagePipeline(deps as never)(msg()),
    ).resolves.toBeUndefined();
    expect(card.fail).toHaveBeenCalled();
    expect(card.fail.mock.calls[0][0]).toContain('出错');
  });

  it('点表情失败不影响正常流程', async () => {
    const { deps, card } = makeDeps({
      react: vi.fn().mockRejectedValue(new Error('no permission')),
    });

    await expect(
      createMessagePipeline(deps as never)(msg()),
    ).resolves.toBeUndefined();
    expect(card.finalize).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/handler/message.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/handler/message"`

- [ ] **Step 3: 写 src/handler/message.ts**

```ts
import { sessionKey, type SessionStore } from '../agent/session-store';
import type { Replier } from '../feishu/reply';
import type {
  StreamCardHandle,
  StreamCardTarget,
} from '../feishu/stream-card';
import type { Logger } from '../infra/logger';
import type { RunAgent } from '../types/agent';
import type { ParsedMessage } from '../types/feishu';
import { RESET_REPLY, WHOAMI_GROUP_HINT, matchCommand } from './commands';

export interface MessagePipelineDeps {
  sessions: SessionStore;
  runAgent: RunAgent;
  openCard: (target: StreamCardTarget) => Promise<StreamCardHandle>;
  reply: Replier;
  react: (messageId: string) => Promise<void>;
  logger: Logger;
}

/**
 * 主流水线: 指令短路 → 会话决策 → 建卡 → 跑模型 → 终态。
 * 只做编排, 所有 IO 由 deps 注入。任何异常都转成用户可读消息, 绝不向上抛。
 */
export function createMessagePipeline(
  deps: MessagePipelineDeps,
): (msg: ParsedMessage) => Promise<void> {
  return async (msg) => {
    // 表情回执是尽力而为, 失败不影响回答
    await deps.react(msg.messageId).catch(() => undefined);

    const key = sessionKey(msg);

    const command = matchCommand(msg.text);
    if (command) {
      switch (command.kind) {
        case 'reset':
          deps.sessions.clear(key);
          await deps.reply(msg, RESET_REPLY);
          return;
        case 'whoami':
          await deps.reply(
            msg,
            msg.chatType === 'group'
              ? WHOAMI_GROUP_HINT
              : `你的 open_id: ${msg.senderOpenId}`,
          );
          return;
        case 'canned':
          await deps.reply(msg, command.text);
          return;
      }
    }

    let card: StreamCardHandle | null = null;
    try {
      card = await deps.openCard({
        chatId: msg.chatId,
        messageId: msg.messageId,
        chatType: msg.chatType,
      });
    } catch (error) {
      deps.logger.error(
        { err: error, chatId: msg.chatId },
        'message: open card failed, falling back to plain text',
      );
    }

    try {
      const result = await deps.runAgent(
        {
          // Plan 1 直接把用户原话当 prompt; 系统头与上下文拼接在 Plan 2
          prompt: msg.text,
          resumeSessionId: deps.sessions.get(key),
        },
        (event) => {
          if (event.type === 'tool') card?.addProgress(event.line);
        },
      );

      if (result.ok) {
        deps.sessions.set(key, result.sessionId);
        if (card) await card.finalize(result.text);
        else await deps.reply(msg, result.text);
        return;
      }

      deps.logger.warn({ chatId: msg.chatId }, 'message: agent reported failure');
      if (card) await card.fail(result.text);
      else await deps.reply(msg, result.text);
    } catch (error) {
      deps.logger.error({ err: error, chatId: msg.chatId }, 'message: pipeline failed');
      const readable = '处理这条消息时出错了, 请稍后再试。详情见 runtime/logs/bot.log。';
      if (card) await card.fail(readable);
      else await deps.reply(msg, readable);
    }
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/handler/message.test.ts`
Expected: PASS（13 个用例）

- [ ] **Step 5: 跑 typecheck 与 lint**

Run: `npm run typecheck && npm run lint`
Expected: 退出码 0

- [ ] **Step 6: 提交**

```bash
git add src/handler/message.ts tests/handler/message.test.ts
git commit -m "feat: 主流水线编排 (指令短路/会话决策/流式作答/失败降级)"
```

---

### Task 14: WS dispatcher、装配点与端到端联调

**Files:**
- Create: `src/feishu/dispatcher.ts`, `src/index.ts`, `README.md`
- Test: `tests/feishu/dispatcher.test.ts`

**Interfaces:**
- Consumes: 前 13 个任务的全部产出
- Produces:
  - `interface DispatcherDeps { appId: string; appSecret: string; logger: Logger; onMessage: (msg: ParsedMessage) => void }`
  - `handleMessageEvent(raw: unknown, logger: Logger, onMessage: (msg: ParsedMessage) => void): void`（纯粹的事件适配，可单测）
  - `startDispatcher(deps: DispatcherDeps): void`

- [ ] **Step 1: 写 tests/feishu/dispatcher.test.ts（失败的测试）**

```ts
import { describe, expect, it, vi } from 'vitest';
import { handleMessageEvent } from '../../src/feishu/dispatcher';
import type { ParsedMessage } from '../../src/types/feishu';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const rawTextEvent = {
  sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
  message: {
    message_id: 'om_1',
    root_id: '',
    parent_id: '',
    create_time: '1700000000000',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '你好' }),
    mentions: [],
  },
};

describe('handleMessageEvent', () => {
  it('解析成功时把 ParsedMessage 交给 onMessage', () => {
    const seen: ParsedMessage[] = [];
    handleMessageEvent(rawTextEvent, logger as never, (m) => seen.push(m));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messageId).toBe('om_1');
  });

  it('不支持的类型静默丢弃, 不调 onMessage', () => {
    const onMessage = vi.fn();
    handleMessageEvent(
      {
        ...rawTextEvent,
        message: { ...rawTextEvent.message, message_type: 'file' },
      },
      logger as never,
      onMessage,
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('onMessage 抛错被吞掉, 不冒泡到 SDK 的事件循环', () => {
    expect(() =>
      handleMessageEvent(rawTextEvent, logger as never, () => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/feishu/dispatcher.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/feishu/dispatcher"`

- [ ] **Step 3: 写 src/feishu/dispatcher.ts**

```ts
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../infra/logger';
import type { ParsedMessage } from '../types/feishu';
import { parseMessageEvent } from './parse';

export interface DispatcherDeps {
  appId: string;
  appSecret: string;
  logger: Logger;
  onMessage: (msg: ParsedMessage) => void;
}

/**
 * 事件适配: 原始事件 → ParsedMessage → 交给上层。
 * 解析不出来的一律静默丢弃; onMessage 抛错也吞掉 —— 抛回 SDK 会污染 WS 事件循环。
 */
export function handleMessageEvent(
  raw: unknown,
  logger: Logger,
  onMessage: (msg: ParsedMessage) => void,
): void {
  const parsed = parseMessageEvent(raw);
  if (!parsed) {
    logger.debug('dispatcher: event ignored (unsupported or malformed)');
    return;
  }

  try {
    onMessage(parsed);
  } catch (error) {
    logger.error({ err: error }, 'dispatcher: onMessage threw');
  }
}

/** 建立飞书 WebSocket 长连接并订阅 im.message.receive_v1。 */
export function startDispatcher(deps: DispatcherDeps): void {
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      handleMessageEvent(data, deps.logger, deps.onMessage);
    },
  });

  const wsClient = new Lark.WSClient({
    appId: deps.appId,
    appSecret: deps.appSecret,
    domain: Lark.Domain.Feishu,
  });

  wsClient.start({ eventDispatcher });
  deps.logger.info('index: dispatcher started');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/feishu/dispatcher.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 写 src/index.ts（唯一装配点，只 wire 不写业务）**

```ts
import 'dotenv/config';
import { resolve } from 'node:path';
import { createAgentRunner } from './agent/stream-runner';
import {
  SESSIONS_FILE,
  createSessionStore,
  sessionKey,
} from './agent/session-store';
import { resolveBotOpenId } from './feishu/bot-info';
import { createFeishuApi, createLarkClient } from './feishu/client';
import { startDispatcher } from './feishu/dispatcher';
import { reactTyping } from './feishu/react';
import { createReplier } from './feishu/reply';
import { openStreamCard } from './feishu/stream-card';
import { parseAllowedGroupChats, loadEnv } from './config/env';
import { filterMessage } from './handler/filter';
import { createMessagePipeline } from './handler/message';
import { BoundedSet } from './infra/bounded-set';
import { ChatLock } from './infra/chat-lock';
import { createLogger } from './infra/logger';

/** spec: message_id 进程内 LRU 去重, 容量 1 万。 */
const DEDUPE_CAPACITY = 10_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const requester = createLarkClient(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET);
  const api = createFeishuApi(requester);
  const botOpenId = await resolveBotOpenId(api, env.FEISHU_BOT_OPEN_ID, logger);

  const sessions = createSessionStore({
    file: SESSIONS_FILE,
    maxIdleHours: env.SESSION_MAX_IDLE_HOURS,
  });

  const runAgent = createAgentRunner({
    bin: env.AGENT_BIN,
    model: env.AGENT_MODEL,
    permissionMode: env.AGENT_PERMISSION_MODE,
    timeoutMs: env.AGENT_TIMEOUT_MS,
    cwd: resolve(env.WORKSPACE_DIR),
    logger,
  });

  const pipeline = createMessagePipeline({
    sessions,
    runAgent,
    openCard: (target) =>
      openStreamCard(
        { api, logger, throttleMs: env.AGENT_STREAM_THROTTLE_MS },
        target,
      ),
    reply: createReplier(api, logger),
    react: (messageId) => reactTyping(api, messageId, logger),
    logger,
  });

  const seen = new BoundedSet(DEDUPE_CAPACITY);
  const allowedGroupChats = parseAllowedGroupChats(env.ALLOWED_GROUP_CHATS);
  const lock = new ChatLock();

  startDispatcher({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    logger,
    onMessage: (msg) => {
      const decision = filterMessage(msg, {
        botOpenId,
        ignoreAtAll: env.IGNORE_AT_ALL,
        allowedGroupChats,
        seen,
      });

      if (decision.action === 'drop') {
        logger.debug(
          { messageId: msg.messageId, reason: decision.reason },
          'filter: dropped',
        );
        return;
      }

      // 同一会话串行, 防并发争抢 session
      void lock.run(sessionKey(msg), () => pipeline(msg));
    },
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'index: uncaught exception, exiting');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'index: unhandled rejection, exiting');
    process.exit(1);
  });
}

main().catch((error) => {
  // env 校验失败等启动期错误: logger 可能还没建起来, 直接打到 stderr
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 6: 跑全量测试、typecheck、lint**

Run: `npm test -- --run && npm run typecheck && npm run lint`
Expected: 全部 PASS，退出码 0。全量测试约 150 个用例。

- [ ] **Step 7: 验证「缺必填项启动即退出」**

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx src/index.ts; echo "exit=$?"
```

Expected: 打印包含 `FEISHU_APP_ID is required` 与 `FEISHU_APP_SECRET is required` 的多行错误，`exit=1`。（`env -i` 保证不读到 shell 里已导出的变量；`.env` 文件如果已存在会被 dotenv 读走，此步请在 `.env` 尚未创建时执行，或临时改名。）

- [ ] **Step 8: 写 README.md**

````markdown
# agentlark

把飞书机器人与本机 `claude` (Claude Code headless) 串起来: 团队成员在飞书里提问,
模型流式作答, 卡片实时更新工具调用进度。

当前实现范围见 `docs/superpowers/plans/`。完整产品设计见 `docs/spec/agentlark-spec.md`。

## 前置条件

1. Node.js ≥ 20
2. `claude` CLI 可用 (`which claude`)
3. 飞书开放平台已建自建应用, 且:
   - **事件与回调** 订阅方式选「长连接」, 订阅 `im.message.receive_v1`
   - **权限** 开通 `im:message`
   - **应用能力 → 机器人** 已启用 (否则 `bot/v3/info` 拿不到 open_id, 群聊 @ 检测失效)
   - 已创建版本并发布

## 启动

```bash
npm install
cp .env.example .env      # 至少填 FEISHU_APP_ID 与 FEISHU_APP_SECRET
npm run dev               # 或 npm start
```

启动日志关键行: `bot-info: bot open_id resolved` / `index: dispatcher started`。

## 使用

| 场景 | 做法 |
|-|-|
| 私聊提问 | 直接发消息, 不需要 @ |
| 群聊提问 | 消息里 **@机器人** + 问题; 只 @不说话不触发 |
| 追问 | 直接接着发, 上下文自动续接 (空闲 24 小时内有效) |
| 换话题 | 发 `/new` |
| 查自己的 open_id | **私聊**发 `/whoami` |

图片 / 富文本 / 引用消息 / 文件 / 语音 / 视频当前**静默忽略**, 发了不会有任何回应。

## 开发

```bash
npm test -- --run   # vitest
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
```

日志在 `runtime/logs/bot.log`, 会话状态在 `user-data/runtime/sessions.json`。

## 排错

| 现象 | 处理 |
|-|-|
| 启动报 `FEISHU_APP_SECRET is required` | 编辑 `.env` 补必填项 |
| 回复里出现「找不到可执行文件 claude」 | `which claude` 拿绝对路径写进 `AGENT_BIN` |
| 群里 @ 不触发 | 日志出现 `bot open_id unresolved` 即失效; 检查机器人能力是否已启用发布, 或直接填 `FEISHU_BOT_OPEN_ID` |
| 发文件/语音没反应 | 预期行为, 不支持类型静默忽略 |
````

- [ ] **Step 9: 端到端手动联调**

前置：`.env` 已填好真实的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，飞书后台已按 README 配置完成。

```bash
npm run dev
```

逐条验收（每条都要真的在飞书里做一遍）：

1. 日志出现 `bot-info: bot open_id resolved` 和 `index: dispatcher started`
2. 私聊发 `你好` → 秒回固定文案，日志里**没有** spawn claude 的记录
3. 私聊发 `/whoami` → 回显 `ou_` 开头的 open_id
4. 私聊发 `读一下当前目录的 package.json，告诉我有哪些 npm script` → 先出现「💭 思考中」卡片，随后卡片上出现 `📖 Read package.json` 之类的进度行，最后 patch 成完整答案
5. 紧接着追问 `其中哪个是跑测试的？` → 答案能接上上一轮的上下文（说明 `--resume` 生效）
6. 发 `/new`，再问同样的追问 → 模型不再知道上下文（说明会话清空生效）
7. 私聊发一张图片 → 无任何回应，日志出现 `dispatcher: event ignored`
8. 把机器人拉进一个群，群里不 @ 直接发消息 → 无回应；@机器人 + 问题 → 正常作答且**引用了原消息**
9. 群里只 @机器人不说话 → 无回应
10. `cat user-data/runtime/sessions.json` → 能看到 `p2p:ou_xxx` 与 `group:oc_xxx` 两条记录
11. Ctrl-C 停掉再 `npm run dev` 起来，继续追问 → 上下文仍在（落盘重启不丢）

任何一条不通过，先看 `runtime/logs/bot.log`，修完再从第 1 条重跑。

- [ ] **Step 10: 提交**

```bash
git add src/feishu/dispatcher.ts src/index.ts README.md tests/feishu/dispatcher.test.ts
git commit -m "feat: WS dispatcher、装配点与 README"
```

---

## 完成标准

Plan 1 完成时，下面每一条都成立：

- `npm test -- --run`、`npm run typecheck`、`npm run lint` 三条命令全绿
- Task 14 Step 9 的 11 条端到端验收全部通过
- `src/index.ts` 里没有任何业务判断（只有 wire 和一个 filter 分发）
- `src/handler/message.ts` 里没有直接 import 任何飞书 SDK、`node:child_process` 或 `node:fs`

## 与后续计划的接口约定

后面三份计划会从这些地方接进来，实现时不要改动它们的签名：

| 扩展点 | 谁来用 |
|-|-|
| `buildAgentArgs(input)` 追加 `addDirs: string[]` 字段 | Plan 2 挂载多仓库（`REPO_PATHS` 别名:路径，数量不限） |
| `MessagePipelineDeps` 新增 `buildPrompt` 依赖 | Plan 2 的系统头 / Wiki 检索指引 / 首轮与续话差异 |
| `parseMessageEvent` 放开 `image` / `post` / 引用消息 | Plan 2 |
| `MessagePipelineDeps` 新增 `quota` 依赖 | Plan 2 群聊每日限额 |
| `createAgentRunner` 追加 `settingsFile` 字段（`--settings`） | Plan 3 注入 PreToolUse hook 与 skillOverrides |
| `startDispatcher` 追加 `card.action.trigger` 订阅 | Plan 3 审批卡片按钮回调 |
| `src/index.ts` 装配审批服务与 pid / 健康探针 | Plan 3 / Plan 4 |
