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
