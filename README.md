# agentlark

把飞书机器人与本机 `claude` (Claude Code headless) 串起来: 团队成员在飞书里提问,
模型流式作答, 卡片实时更新工具调用进度。

当前实现范围见 `docs/superpowers/plans/`。完整产品设计见 `docs/spec/agentlark-spec.md`。

## 前置条件

1. Node.js ≥ 20
2. `claude` CLI 可用 (`which claude`)
3. 飞书开放平台已建自建应用, 且:
   - **事件与回调** 订阅方式选「长连接」, 订阅 `im.message.receive_v1`
   - **权限** 除收发消息的 `im:message` 外, 还要开通:
     - 「更新应用发送的消息卡片」—— 流式卡片全靠 patch 更新, 缺了卡片会永远停在「💭 思考中」
       (日志刷 `stream-card: patch failed`)
     - 「添加消息表情回复」—— 缺了只是丢一个 Typing 回执, 日志出现 `react: typing reaction failed`
   - **应用能力 → 机器人** 已启用 (否则 `bot/v3/info` 拿不到 open_id, 群聊 @ 检测失效)
   - 已创建版本并发布

## 安全须知 (先读这一段)

Plan 3 的审批闸门还没做, 模型现在是以 `--permission-mode bypassPermissions` 跑在
`WORKSPACE_DIR` 里的 —— 谁能给这个机器人发消息, 谁就等于拿到了你这台机器上的一个 shell。
所以:

- **不要把这一版发布给全租户可见**, 更不要上应用商店; 只在自己和少数同事之间用
- **务必设置 `ALLOWED_USERS`** (逗号分隔的 open_id, 私聊发 `/whoami` 可以查到自己的),
  留空表示允许全部人
- `WORKSPACE_DIR` 必须是一个独立的代码目录: 它不能是本仓库根目录, 也不能是本仓库的上级目录,
  否则模型能直接读到 `.env` 里的 `FEISHU_APP_SECRET`。启动时会校验, 违规直接退出

## 启动

```bash
npm install
cp .env.example .env      # 至少填 FEISHU_APP_ID / FEISHU_APP_SECRET / WORKSPACE_DIR
npm run dev               # 或 npm start
```

必填三项里 `WORKSPACE_DIR` 是模型子进程的工作目录 (没有默认值), 指向你想让它读写的那个
代码仓库, 例如 `/Users/you/repos/web-main`。建议同时填上 `ALLOWED_USERS`。

启动日志关键行: `bot-info: bot open_id resolved` / `index: dispatcher started`
(后者由 WebSocket 握手成功触发, 打出来才说明真的连上了)。

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
| 启动报 `FEISHU_APP_SECRET is required` / `WORKSPACE_DIR is required` | 编辑 `.env` 补必填项 |
| 启动报 `Invalid WORKSPACE_DIR` | `WORKSPACE_DIR` 指到了本仓库自己或其上级目录, 换成一个独立的代码目录 |
| 起来了但没有 `index: dispatcher started` | 握手没成功; 看日志里的 `dispatcher: websocket connection failed` / `start failed`, 多半是 app secret 或事件订阅方式配错 |
| 卡片一直停在「💭 思考中」| 日志刷 `stream-card: patch failed` 即缺卡片更新权限; 答案会退回成纯文本发出来 |
| 发消息没反应, 日志显示 `user-not-allowed` | 发送人不在 `ALLOWED_USERS` 里 |
| 回复里出现「找不到可执行文件 claude」 | `which claude` 拿绝对路径写进 `AGENT_BIN` |
| 群里 @ 不触发 | 日志出现 `bot open_id unresolved` 即失效; 检查机器人能力是否已启用发布, 或直接填 `FEISHU_BOT_OPEN_ID` |
| 发文件/语音没反应 | 预期行为, 不支持类型静默忽略 |
