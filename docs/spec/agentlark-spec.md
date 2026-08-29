<title>agentlar</title>

# **agentlark — 飞书 AI Agent 桥接服务**



把飞书机器人 `cli_xxxxxxxxxxxxxxxx` 与本机 `claude` (Claude Code headless) 串起来:

团队成员在飞书里提问, 模型结合 项目仓库 + 飞书知识库本地缓存给出回答;

开启审批闸门后, 还能通过飞书卡片远程授权模型执行部署、推送等写操作。



一条消息的旅程: \*\*飞书 WS 长连接 → 过滤/路由 → 拼 prompt → spawn claude 流式执行 →

飞书卡片实时更新 → (写操作) 审批卡片/改动汇总\*\*。



**---**



## **核心功能**



### **在飞书里直接问 AI**



- 私聊直接发消息, 群聊 @机器人触发; @全体成员默认忽略 (`IGNORE_AT_ALL`)
- 支持纯文本、图片 (单条最多 10 张, 可只发图)、富文本 (post, 文本/代码块/图片/@ 展平)、

引用消息提问 (含被引用消息里的图片, 合并转发逐条展开)

- 文件/音频/视频静默忽略; 只 @不说话不触发

### **持久会话**



按会话维度 (私聊按人、群聊按群) 复用 claude session, `--resume` 续接上下文,

空闲 24 小时过期, 落盘重启不丢。问 AB 实验/GrowthBook 类问题时**自动开新会话**,

避免旧上下文污染实验查询; 闲聊/健康检查走轻量 prompt, 不占用长期会话。



### **多仓库 + 飞书知识库上下文**



- 5 个代码仓库 (web-main / mobile-app / web-personal / shop-site / knowledge) 通过

`--add-dir` 挂载, 模型可直接读源码

- 飞书 Wiki 每小时同步到 `runtime/wiki-cache/*.md`, 模型用 `rg`/`grep` 自行检索,

知识库大小不占对话长度; 引用了哪篇文档会在回复里标注来源

### **流式卡片回复**



所有回答一律流式: 先发「💭 思考中」卡片, 实时追加工具调用进度

(📖 Read / 🔧 Bash / 🔍 Grep …), 最后 patch 成完整回复。节流 500ms,

超 30KB 自动裁进度行, patch 连续失败自动发新卡片续传, 内容不丢。



### **分级写操作闸门**



`APPROVAL_ENABLED=true` 时模型获得写能力, 每次工具调用被 PreToolUse hook 拦下,

按**实际要执行的动作** (不是用户措辞) 四级分流: 只读放行 / 改文件放行+事后汇总 /

部署推送发卡片等确认 / 不可逆操作硬拒绝。审批卡以**用户意图**为粒度: 一次「部署」

只弹一张意图卡 (带仓库/分支/环境坐标与发卡前的 git 风险体检), 批准后同一意图的

后续动作自动放行; 认不出意图的命令也会先被规则翻译成人话 (「是否允许: 查看群聊

消息…」) 再展示原文。详见 \[架构 · 审批闸门\](#审批闸门-四级分流--意图授权)。

关闭审批则模型完全无写权限。



### **Skill 按需加载**



挂载的 5 个仓库合计 100+ 个项目 skill, claude 原生会把每个的描述全量预载进

会话上下文。bot 通过 `--settings` 注入 `skillOverrides`, 把它们统一降为

`name-only`: 名字保留在列表里 (模型仍可按需调用, 调用时 SKILL.md 全文才加载),

描述不再预载。高频 skill 白名单 (`AGENT_SKILLS_FULL`, 默认

`deploy-status,ab-experiment-query`) 保留完整描述作为路由依据。

只影响 bot 拉起的子进程, 终端手动使用 claude 不受影响。



### **限额与输出安全**



- 群聊每日限额 (全部群共 50 次、单群 20 次), 私聊不限; 指令与固定直答不扣额度
- 回复发出前凭据脱敏 (`TOKEN=`/`Bearer`/`cookie:` → `[REDACTED]`)、

本机绝对路径映射为仓库别名 (`[web-main]/src/...`), 未知路径打码为 `[external:指纹]`

**---**



## **使用方式**



部署与启动见 \[附录: 部署与排错\](#附录-部署与排错)。以下是跑起来之后各角色怎么用。



### **团队成员: 提问**



| 场景 | 做法 |
|-|-|
| 私聊提问 | 直接给机器人发消息, 不需要 @ |

| 群聊提问 | 消息里 **@机器人** + 问题; 只 @不说话不触发, @全体成员默认被忽略 |

| 带截图提问 | 直接贴图片发送 (单条最多 10 张, 可只发图不写字), 模型能看图 |

| 引用提问 | 回复某条历史消息再 @机器人 (如「引用一张报错截图问怎么修」), 被引用内容与其中的图片会一并带给模型 |

| 追问 | 直接接着发, 上下文自动续接 (空闲 24 小时内有效); 想换话题发 `/new` |



收到消息后机器人会先点一个 Typing 表情表示已接收, 随后发「💭 思考中」卡片并实时

更新工具调用进度, 最终 patch 成完整回答。



注意事项:



\- **文件/语音/视频不支持**, 发了不会有任何回应 (静默忽略, 不报错)

\- 群聊有每日额度 (全部群共 50 次、单群 20 次), 超限会收到提示; **私聊不限额**,

  高频使用建议私聊

- 问 AB 实验/GrowthBook 类问题会自动开新会话查询, 无需手动 `/new`
- 回答里引用了飞书 Wiki 文档时, 末尾会标注 `> 来源: 文件名.md`

### **团队成员: 指令**



严格全匹配 (指令前后不能带其他文字), 不启动模型、不扣群聊额度:



| 发送内容 | 效果 |
|-|-|
| `/new` `/reset` `新对话` `重置` | 清空当前会话上下文, 下一条消息用全新会话 |

| \`/whoami\` \`/myid\` | 回显你的 open_id (**必须私聊发**, 群里拿到的是群 id) |

| `你好` / `ping` / `测试` / `你是谁` | 固定文本直答, 秒回 |



### **审批人 (主人): 处理写操作**



前置: 私聊机器人发 `/whoami` 拿到自己的 open_id, 填进 `.env` 的

`APPROVAL_APPROVER_OPEN_ID`, 并设置 `APPROVAL_ENABLED=true` 后重启。



之后当模型要执行写操作时, 你会在**私聊**收到:



\- **审批卡片** (部署/推送/装依赖等 ask 级操作): 卡片开头是人话描述的意图

  (「部署 web-main@master → 生产」) 与发卡前的 git 风险体检结果, 点「批准」后执行,

  同一意图的后续步骤 30 分钟内自动放行; 点「拒绝」或 **10 分钟不处理则自动拒绝**。

  卡片被转发给别人也没用 —— 回调会校验点按钮的必须是审批人本人

\- **改动汇总卡片** (改文件等 notify 级操作): 不需要点击, 任务结束后一张卡列出

  改了哪些文件、各改了什么, 事后知情用



分级规则 (哪些操作直接放行、哪些发卡、哪些硬拒绝) 见

\[架构 · 审批闸门\](#审批闸门-四级分流--意图授权)。



### **运维: 日常操作**



```Bash
npm run status    # 查看进程状态 (自动识别 launchd 托管)
npm run restart   # 重启
npm run stop      # 停止 (launchd 托管时走 bootout, 不会被自动拉起)
npm run sync:wiki # 单独手动同步一次 Wiki (不起 bot)
npm test -- --run # 跑测试
```



日志在 `runtime/logs/bot.log`; 常见问题对照 \[排错\](#排错) 表。



**---**



## **架构**



### **技术栈与运行形态**



| 项 | 说明 |
|-|-|
| 运行时 | Node.js ≥ 20, TypeScript ESM, `tsx` 直跑不构建 |

| 飞书接入 | \`@larksuiteoapi/node-sdk\` **WebSocket 长连接** (无需公网 IP), 订阅 \`im.message.receive_v1\` + \`card.action.trigger\` |

| 模型执行 | spawn 本机 `claude` CLI (headless, `stream-json` 输出), 子进程 env 白名单收敛 (`agent/child-env.ts`) |

| 配置 | `.env` + zod schema 校验 (`config/env.ts`), 缺必填项启动即退出 |

| 日志/测试 | pino / vitest + eslint + tsc |

| 进程管理 | pid 文件单实例互斥; macOS launchd 托管自动拉起; 可选 `/healthz` `/readyz` 探针 |



### **模块划分**



```Plain Text
src/
├── index.ts        # 唯一装配点: 读 env → wire 所有依赖 → 启动 wiki 同步 + WS dispatcher
├── config/env.ts   # zod 环境变量 schema
├── feishu/         # 飞书适配层: client / dispatcher(WS) / parse / mention / reply /
│                   #   stream-card(流式卡片) / image-fetcher / quoted-fetcher /
│                   #   user-name(发起人 open_id→姓名) / output-sanitizer(脱敏) / markdown / bot-info
├── handler/        # 编排层: filter(该不该处理) / message(主流水线) / security(关键词守卫)
├── agent/      -    # claude 子进程: args(拼 argv) / child-env / stream-runner /
│                   #   stream-parser / session-store
├── context/        # 上下文: prompt-builder(纯函数) / wiki-fetcher(lark-cli) /
│                   #   wiki-sync(定时+原子写) / wiki-cache(读端)
├── approval/       # 审批闸门: policy(四级分流) / intent(意图识别) / grant(意图授权) /
│                   #   risk(发卡前仓库体检) / describe(命令→人话翻译) / allowlist(临时白名单) /
│                   #   server(127.0.0.1 HTTP) / card + card-elements(schema 2.0 卡片) /
│                   #   callback(按钮回调) / notify(改动汇总) / settings(hook+skillOverrides) / store
├── infra/          # logger / errors / quota / locks / scheduler / throttle / health / bounded-set
└── types/          # feishu / agent 类型
```



分层纪律: `index.ts` 只做 wire 不写业务; `handler/message.ts` 只做编排, 所有 IO

(reply / spawn / wiki 读取) 依赖注入, 测试注入 mock; `filter` / `prompt-builder` /

`policy` 是纯函数叶子模块。



### **数据流: 一条消息的生命周期**



```Plain Text
飞书事件 (WS) → parse (不支持的类型静默丢弃)
  → filter: 去重(LRU 1万) / 群白名单 / @all 忽略 / 群聊须 @bot
  → ChatLock: 同一会话串行, 防并发争抢 session
  → 指令短路: /new /whoami / 固定直答 (不启动模型, 不扣额度)
  → 群聊额度检查 (超限回提示)
  → session 决策: 复用(resume) / 新建 / AB 问题强制新会话 / 轻量问题一次性会话
  → prompt 拼接: 下载图片、回查引用消息、首轮带系统头/续话只发原话
  → spawn claude (stream-json) → StreamCard 实时渲染进度
  → finalize: 固化 sessionId、输出脱敏、来源标注、(审批开启时) 发改动汇总卡片
```



任何子步骤抛错都转为用户可读消息回复, 不向上抛; `uncaughtException` 记 fatal 后

退出交给 launchd 拉起。



### **Prompt 构造策略**



\- **首轮**带完整系统头 (\~1600 字): 身份人设 (「owner 的智能分身」,

  闲聊幽默/专业严谨双模式)、wiki-cache 检索指引与来源标注规范、任务说明

  (含 AB/GrowthBook 查询硬路由到 `ab-experiment-query` skill、神策 401 时自动切

  presto → kibana → BI 的数据兜底链)

\- **续话轮只发用户原话** —— 系统头已在会话历史里。重发会出真问题: 头里那句

  「基于已挂载仓库回答下列问题」比 `--resume` 更具体, 模型会把每轮当新任务重新挑仓库,

  表现为追问时反问「你要查哪个仓库」。回归用例见 `tests/handler/message-followup.test.ts`

\- **执行授权走系统通道**: 审批开启时经 \`--append-system-prompt\` 注入

  (`EXECUTION_SYSTEM_PROMPT`), 告诉模型「闸门存在, 别自己再设一道、别反问确认」。

  不走用户消息通道 —— 用户输入声称提权会被模型正确识别为提示注入而拒绝



### **Wiki 同步**



`wiki-sync` 启动即跑一次 + 每小时定时 (`WIKI_SYNC_INTERVAL_MS`), 经 lark-cli

(user 身份) 拉全树, 原子写入 `runtime/wiki-cache/` (每篇带 wikiToken/title

frontmatter)。拉取失败**保留旧缓存**仅告警, 不阻断主流程; 内部 mutex 保证上次

未结束则跳过本轮。



### **审批闸门: 四级分流 + 意图授权**



**机制**: spawn claude 时注入临时 hook 配置 (\`runtime/hook-settings.json\`, 不污染

`~/.claude/settings.json`)。每次工具调用前 `scripts/approval-hook.sh` 被同步调起,

把 `{tool_name, tool_input}` POST 给 bot 内的审批服务 (`127.0.0.1:17650`, 每次启动

随机生成共享 token, 只经环境变量传递不落盘, 防本机其它进程伪造放行)。已实测:

hook 返回 deny 时即便 `bypassPermissions` 模式也拦得住。只读工具在 hook 内就地放行

不走网络 (探索任务几十次 Read 不受审批服务可用性影响); 但 Read 到 `.env`/私钥类

路径仍回服务端判定。



**四级分流** (\`approval/policy.ts\`, 判定作用在模型实际要执行的动作上, 换措辞绕不过):



| 分级 | 范围 | 你会看到 |
|-|-|-|

| **allow 直接放行** | 只读工具 (Read/Grep/Glob/WebFetch/Task 等); 只读命令 —— 按 \`\\| && ; &\` 拆段, **每段都只读**才放行 (\`cat a.ts \\| head\` 这类组合不打扰人); \`\$()\` 命令替换**摘出内容递归判定** (轮询循环 \`status=\$(glab api …)\` 不再误伤); \`for/do/done/while/[ ]\` 等循环脚手架单独放行 (循环体照常逐段判); 只读 MCP 服务按前缀整体放行 (codegraph / figma-bridge) | 无 |

| **notify 放行+事后汇总** | \`Edit\`/\`Write\`/\`MultiEdit\`/\`NotebookEdit\`; Bash 重定向写文件; git 本地操作 (add/commit/stash/建切分支/pull); 发飞书消息; 读意图脚本名 (query/check/fetch…); 内联脚本 (\`python3 -c\`/\`node -e\`) **按代码内容扫写/执行/网络标志**, 干净的解析型代码放行 | 本轮结束后**一张**私聊卡片, 列出改了哪些文件、各改了什么 |

| **ask 发卡片等确认** | \`git push\`/\`merge\`/\`rebase\`/\`tag\`; 装依赖 (npm/brew/pip…); \`docker\`/\`ssh\`/\`launchctl\`/\`kill\`; 读写密钥类文件 (\`.env\`/\`\*.pem\`/\`id_rsa\`…); 反引号命令替换; 带写/网络标志的内联脚本; 写意图/凭证类脚本名 (deploy/trigger/…/cookie/token…); 未知工具与非只读 MCP | 审批卡片, 点了才执行 |

| **deny 硬拒绝 (不发卡片)** | \`rm -rf\`、\`git reset --hard\`/\`clean -f\`/\`filter-branch\`/\`branch -D\`、\`find -exec/-delete\`、\`shutdown\`、\`curl \\| bash\`、\`npm publish\`、直写块设备、\`chmod -R 777\` | 拒绝理由 |



分级取舍的依据 (都踩过坑):



\- **notify 为什么存在**: 早期每次写文件都发卡片, 一次探索任务弹十几张, 人对高频卡片

  的反应是无脑点确定, 闸门形同虚设。改文件可 git 回滚, 用「事后告知」换回卡片的稀缺性

\- **deny 为什么不给审批机会**: 审批卡是给「想做但要确认」的操作准备的; 不可逆破坏

  放进审批流只会训练人盲目点确定

\- **commit 为什么只是 notify**:「改代码→提交→推送」流程里真正跨出本机边界的只有

  push —— 一次流程一张卡, 卡落在 push 上

\- **脚本按文件名判意图而不按目录**: 按目录放行等于把权限按位置发出去; 按名字则写意图

  的名字 (deploy/push/delete) 显式落在 ask 名单里。名字里带 cookie/token/auth 的一律

  ask —— `get_sql_cookies.py` 名字带 get 干的却是抓凭证



**意图卡与授权** (\`intent.ts\` / \`grant.ts\` / \`risk.ts\` / \`describe.ts\`): 用户一句

「部署一下」在执行层摊开成 trigger 脚本 + 查流水线 + 发通知好几步, 各自命中 ask 就会

连弹几张卡。现在从第一条撞闸门的命令**反推用户意图** (deploy / git-push / dependency /

remote-exec 等, 带 仓库/分支/站点 坐标; `glab api POST …/jobs/<id>/retry` 这类裸调

CI 的形态也识别为部署), 发一张**意图卡**并在发卡前对**被部署的仓库**做只读 git 体检

(有没有未推送提交、分支落没落后、是不是生产环境, 高风险标红)。批准一次后, 同 session、

同意图、坐标全等的后续 ask 动作自动放行 (30 分钟 TTL, 随任务结束回收); 永远越不过

deny, 读密钥类 ask 也吃不到授权。



识别不出意图的兜底卡, 开头也是**规则翻译的人话** (「是否允许: 查看群聊消息 (群

oc_xx…), 再用内联 Python 脚本处理输出?」), 命令原文降级为佐证。刻意不让模型自己

描述 —— 描述是审批人做决定的依据, 让被审批方写案情摘要可被诱导; 翻不出来退回

展示原文, 宁可难读也不编造。



卡片为 schema 2.0: 「发起人」用 person 组件渲染头像+姓名胶囊 (open_id 由

`feishu/user-name.ts` 三级解析: contact API 真名 → 审批人本人「你（主人）」→

短 open_id)。



**临时白名单** (\`allowlist.ts\`): 主人不在时, 可给特定同事免掉点击 —— 每条是

open_id + 仓库 + 分支 + 站点四元组全等匹配, 带过期时间, 任何一项对不上退回正常审批。



**失败语义** (fail-closed):



- 审批超时 10 分钟, 超时默认拒绝; 审批卡片发送失败默认拒绝, 不静默放行
- 卡片可被转发, 回调会校验点按钮的是不是审批人本人
- 审批服务只绑 `127.0.0.1` (该端口能放行代码写入, 绝不可对外)

\- 改动汇总卡片发送失败只记日志 —— 它是告知不是闸门; 任务失败/崩溃时汇总**照发**,

  崩之前改的文件是真实存在的

- `APPROVAL_ENABLED=false` 时不写 hook 配置、不起审批服务, 模型完全无写权限,

退回 `handler/security.ts` 的用户措辞关键词拦截

> ⚠️ `AGENT_PERMISSION_MODE` 默认 `bypassPermissions`, 模型在挂载目录内自主读写,

\> 真正的闸门是审批 hook。**关掉审批就等于无人把关的完全写权限。**



### **运行时状态与持久化**



| 文件 | 内容 | 特性 |
|-|-|-|
| `user-data/runtime/sessions.json` | chat → sessionId 映射 | 重启不丢; 每 3 天 01:00 清理过期私聊会话, 群聊惰性过期 |
| `user-data/runtime/quota.json` | 每日群聊额度计数 | 重启不恢复额度; 调用失败不退还 |
| `user-data/runtime/approvals.json` | 在途审批请求 | 必须持久化, 否则重启让在途审批失效 |
| `runtime/wiki-cache/` | 飞书 Wiki 本地快照 | 原子写, 同步失败保留旧缓存 |
| `runtime/bot.pid` | 单实例互斥 | 发现活着的旧实例则新进程退出 |
| `runtime/hook-settings.json` | 传给 claude 的临时配置: PreToolUse hook + skillOverrides (skill 按需加载) | 每次启动重写 |



意图授权 (GrantStore) 与改动累积器只在内存 —— 进程重启后在途 claude 子进程已终止,

落盘反而会让新会话继承旧授权。



**---**



## **能力盘点**



### **消息接入**



| 能力 | 说明 |
|-|-|
| 私聊问答 | 直接发消息即触发, 不需要 @ |
| 群聊问答 | 必须 @机器人; 群可用 `ALLOWED_GROUP_CHATS` 白名单限制 (留空 = 全部群) |
| 图片理解 | 下载到本地临时目录并 `--add-dir` 挂给模型; 单条最多 10 张, 超出截断; 启动时清理残留 |
| 富文本 (post) | 文本/代码块/图片/@ 展平为纯文本, 超链接只保留文字 |
| 引用提问 | 回查被引用消息正文与图片 (「引用一张报错截图问怎么修」可用); 合并转发逐条展开; 回查失败降级不阻断 |
| @全体成员忽略 | 默认丢弃 @all 消息, `IGNORE_AT_ALL=false` 可改为响应 (公共群答疑 bot 场景) |
| 消息去重 | message_id 进程内 LRU (1 万) 防重复消费 |
| 不支持类型 | 文件/音频/视频静默忽略, 不回复 |



### **内置指令 (严格全匹配, 不启动模型、不扣额度)**



| 指令 | 作用 |
|-|-|
| `/new` `/reset` `新对话` `重置` | 清空当前会话上下文, 下一条消息用全新会话 |

| \`/whoami\` \`/myid\` | 回显发送者 open_id (**必须私聊**, 群里拿到的是群 id); 用于配置 \`APPROVAL_APPROVER_OPEN_ID\`, 比申请通讯录权限反查邮箱简单 |

| `你好` / `ping` / `测试` / `你是谁` 等 | 固定文本直答, 不走模型 |



### **会话与上下文**



| 能力 | 说明 |
|-|-|
| 持久会话 | 私聊按发送人、群聊按群独立; `--resume` 续接; 空闲 24h 过期 (`SESSION_MAX_IDLE_HOURS`) |
| AB 问题自动新会话 | 正则命中「AB/GrowthBook/实验 × 更新/配置/状态/在跑」类问题时强制开新会话, 防旧上下文污染 |
| 轻量直答通道 | 问候/健康检查类走一次性会话 + 轻量 prompt (不查库不读仓库), 不固化长期 session |
| 多仓库挂载 | `REPO_PATHS_*` 5 仓 `--add-dir` 挂载, 留空跳过 |
| Wiki 检索 | 每小时同步 + 模型自检索 `runtime/wiki-cache/`; 回复中引用自动标注 `> 来源: 文件名.md` |
| AB 查询路由 | prompt 硬约束: AB/GrowthBook 问题走 `ab-experiment-query` skill, 不走 PV 兜底链 |
| 数据源兜底链 | 神策 401 (子进程无 SENSORS_COOKIE) 时自动切 presto → kibana → BI, 禁止误报「凭证过期」 |



### **回复**



| 能力 | 说明 |
|-|-|
| 流式卡片 | 「思考中」→ 实时工具进度 → 终态回复; 节流 500ms (`AGENT_STREAM_THROTTLE_MS`) |
| 超限自愈 | 卡片 30KB / markdown 3800 字硬限, 超出裁最早进度行; patch 连续 3 次失败发新卡片续传 |
| 回复形态 | 群聊引用原消息, 私聊直发; 建卡失败才降级为纯文本提示 |
| 输出脱敏 | 凭据 `[REDACTED]`; 已知仓库路径 → `[别名]/相对路径`, 未知绝对路径 → `[external:指纹]/末两段` |



### **写操作与审批**



| 能力 | 说明 |
|-|-|
| 四级分流 | allow / notify / ask / deny, 判定作用在真实 tool_input (见架构) |
| 意图卡 | ask 操作归并为用户层意图 (「部署 X@分支 → 站点」), 一次意图一张卡 |
| 命令人话翻译 | 兜底卡开头为规则翻译的意图问句 (lark-cli/glab/git/脚本/内联代码), 原文保留为佐证 |
| 发起人标签 | schema 2.0 person 组件, 头像+姓名胶囊; 姓名三级解析降级 (真名→你（主人）→短 open_id) |
| 发卡前风险体检 | 只读 git 检查未推送提交/分支落后/生产目标, 高风险标红; 体检失败静默跳过卡片照发 |
| 意图授权 | 批准后同 session 同意图后续动作免审, 30 分钟 TTL, 任务结束即回收 |
| 改动汇总 | notify 级操作累积, 一轮结束发一张私聊卡片列全部改动 (失败/崩溃也发) |
| 临时白名单 | open_id+仓库+分支+站点 四元组 + 过期时间, 给特定同事临时免点击 |
| 审批人校验 | 卡片按钮回调验证操作者是审批人本人 |
| fail-closed | 超时/发卡失败/审批通道缺失一律拒绝 |



### **限额**



- 群聊全局 50 次/天 (`QUOTA_DAILY_TOTAL`)、单群 20 次/天 (`QUOTA_DAILY_PER_CHAT`), 0 = 不限
- 私聊不计数不受限; 超限提示可私聊
- 本机时区跨天归零, 落盘重启不恢复; 指令/直答/被过滤消息不扣; 调用失败不退还

### **运维能力**



| 能力 | 入口 |
|-|-|
| 启动/开发 | `npm start` / `npm run dev` (watch) |
| 进程管理 | `npm run status` / `restart` / `stop` (自动识别 launchd 托管, stop 走 bootout) |
| 开机自启 | `scripts/com.agentlark.bot.plist`, 异常退出 10s 拉起 (普通 kill 会被复活) |
| 防休眠 | `npm run keepawake:install` |
| 单独同步 wiki | `npm run sync:wiki` (不起 bot) |
| 健康探针 | `HEALTH_PORT` 配置后 `/healthz` (存活) + `/readyz` (WS 建连后才 ready) |
| 质量 | `npm run typecheck` / `lint` / `npm test -- --run` (vitest, tests/ 按模块分目录全覆盖) |



**---**



## **附录: 部署与排错**



### **前置条件**



1. **Node.js ≥ 20**

2. **claude CLI 可用** — launchd 托管时 PATH 不含 \`\~/.local/bin\`, 需把绝对路径写进 \`AGENT_BIN\`

3. **lark-cli user 身份已登录** (\`lark-cli auth status\` 期望 user ready), 可读 Wiki 根节点

4. **挂载仓库已 clone** (见 \`.env.example\` 的 \`REPO_PATHS\_\*\`)

5. **飞书应用后台已配置** (见下节)



### **安装与启动**



```Bash
cd agentlark
npm install
cp .env.example .env     # 至少填 FEISHU_APP_SECRET
npm run dev              # 或 npm start
```



启动日志关键行: `index: dispatcher started` (WS 建连) / `index: wiki sync scheduled` /

`index: write approval ENABLED` / `approval-server: listening on 127.0.0.1`。



launchd 托管:



```Bash
cp scripts/com.agentlark.bot.plist ~/Library/LaunchAgents/
# 编辑副本, 替换 {{PROJECT_ROOT}} / {{NODE_BIN}} / {{HEALTH_PORT}}
launchctl load ~/Library/LaunchAgents/com.agentlark.bot.plist
```



### **飞书后台配置**



进入 [开放平台](https://open.feishu.cn/app/cli_xxxxxxxxxxxxxxxx):



1. **事件与回调** — 订阅方式选「长连接」; 订阅 \`im.message.receive_v1\` 与

   `card.action.trigger` (少了后者, 审批卡片按钮点了没反应)

2. **权限** — 按下方\[飞书权限列表\](#飞书权限列表)逐条开通; 最低可用集只有

   `im:message` 一条, `contact:*` 两条按需

3. **应用能力 → 机器人** 启用 (也是 \`bot/v3/info\` 自动解析 open_id 的前置条件)

4. **创建版本并发布** (需企业管理员审核)



### **飞书权限列表**



应用 (`cli_xxxxxxxxxxxxxxxx`) 维度的完整权限清单。每条都对应代码里的真实调用点,

表里没有的权限一律不需要:



| 权限 scope | 必需性 | 支撑能力 | 代码位置 |
|-|-|-|-|

| \`im:message\`<br>获取与发送单聊、群组消息 | **必需** | 一条覆盖全部消息类 API (官方文档对以下每个接口均标注「任一权限即可」, 本应用统一由它满足):<br>① 接收单聊/群聊消息事件 \`im.message.receive_v1\`<br>② 发送/回复/patch 流式卡片、审批卡片、改动汇总<br>③ 回查被引用消息 (\`im.v1.message.get\`)<br>④ 下载消息图片 (\`im.v1.messageResource.get\`)<br>⑤ 收到消息即点表情回执 (\`im.messageReaction.create\`) | \`feishu/dispatcher.ts\`<br>\`feishu/reply.ts\` \`stream-card.ts\`<br>\`approval/card.ts\` \`approval/notify.ts\`<br>\`feishu/quoted-fetcher.ts:128\`<br>\`feishu/image-fetcher.ts:141\`<br>\`feishu/react.ts:29\` |

| `im:message:send_as_bot`<br>以应用的身份发消息 | 已配, 与 `im:message` 互为替代 | 主动发消息 (`im.message.create`) 的另一条授权路径; 官方标注与 `im:message` 二选一即可, 现网两个都勾, 保留无害 | 同上 ② 的发消息调用点 |

| \`im:chat:readonly\`<br>获取群组信息 | 已配, **代码未使用** | 当前代码没有任何 \`im.chat.\*\` 调用 —— 群白名单 (\`ALLOWED_GROUP_CHATS\`) 是纯 chat_id 字符串比对, 不查群信息。保留仅为将来群名展示预留, 移除不影响现有功能 | 无调用点 |

| \`contact:user.id:readonly\`<br>通过手机号或邮箱获取用户 ID | 可选 | ① 回复正文里的邮箱解析成可点击的 \`<at>\` 真艾特, 查不到静默降级为字面邮箱<br>② \`APPROVAL_APPROVER_OPEN_ID\` 未配置时按 email 发审批卡的回退路径 —— 缺该权限发卡报 \`99991672\`, 且发卡失败默认拒绝, 表现为**所有写操作被拒** (见\[排错\](#排错)) | \`feishu/mention.ts:103\`<br>\`src/index.ts:190\` |

| \`contact:contact:readonly_as_app\`<br>以应用身份读取通讯录 | 可选 (现网已配) | 审批/汇总卡「发起人」真名与 person 头像标签的数据来源 (\`contact.v3.user.get\` open_id → name)。**必须是应用身份权限**: 只配用户身份的 \`contact:user.base:readonly\` 时, tenant_access_token 调该接口返回 200 但 user 里**没有 name 字段**, 会降级显示「你（主人）」或短 open_id。同时受「可访问的数据范围」限制, 范围外的人查不到 | \`feishu/user-name.ts:43\` |



不占权限但有前置条件的调用:



- `GET /open-apis/bot/v3/info` (启动时自动解析 `FEISHU_BOT_OPEN_ID`) — 官方标注

  权限「无」, 但要求**应用能力 → 机器人已启用并发布** (\`feishu/bot-info.ts:31\`)

- `card.action.trigger` 卡片按钮回调 — 是事件订阅不是权限, 在「事件与回调」配置

与权限无关的两点澄清:



\- **Wiki 同步不消耗本应用权限**: \`context/wiki-fetcher.ts\` 通过 lark-cli 的

  **user 身份**拉取知识库, 权限挂在个人授权上, 本应用无需任何 wiki/docs scope

- 若想收窄 `im:message`: 事件接收可换成 `im:message.p2p_msg:readonly` +

`im:message.group_at_msg:readonly`, 但发消息/读引用/下图/表情仍各需 `im:message`

系权限, 收益有限; 引用回查刻意只用按 id 读单条, 不用需要

`im:message.group_msg` 敏感权限的群历史接口 (`quoted-fetcher.ts` 头注)

### **配置项**



完整键见 `.env.example`, 常用项:



| Key | 默认 | 说明 |
|-|-|-|
| `FEISHU_APP_SECRET` | (必填) | App Secret |
| `FEISHU_BOT_OPEN_ID` | (建议填) | 留空自动调 `bot/v3/info` 解析; 拿不到则群 @ 检测失效 |
| `AGENT_BIN` | `claude` | claude 路径; launchd 下建议绝对路径 |
| `AGENT_MODEL` | (空) | 留空由 `~/.claude/settings.json` 决定 |

| \`AGENT_TIMEOUT_MS\` | \`120000\` | 单次调用超时; **\*\*必须大于 \`APPROVAL_TIMEOUT_MS\`\*\*** |

| `AGENT_PERMISSION_MODE` | `bypassPermissions` | 模型权限模式, 真正的闸门是审批 hook |

| `AGENT_STREAM_THROTTLE_MS` | `500` | 流式卡片刷新节流 |

| `AGENT_SKILLS_FULL` | `deploy-status,ab-experiment-query` | 保留完整描述的 skill 白名单, 其余降 name-only 按需加载 |

| `IGNORE_AT_ALL` | `true` | 忽略 @全体成员 |

| `WORKSPACE_DIR` | `cwd` | 模型子进程工作目录 |

| `REPO_PATHS_*` | (5 项) | 挂载仓库绝对路径, 留空跳过 |

| `WIKI_SYNC_INTERVAL_MS` | `3600000` | Wiki 同步周期 |

| \`ALLOWED_GROUP_CHATS\` | (空) | 群白名单; **留空 = 允许全部群** |

| `APPROVAL_ENABLED` | `false` | 开启写操作审批; 关闭 = 完全禁写 |

| `APPROVAL_APPROVER_OPEN_ID` | (空) | 审批人 open_id, 用 `/whoami` 获取; 留空回退 email 发卡 (需 `contact:user.id:readonly`, 见\[飞书权限列表\](#飞书权限列表), 常失败) |

| `APPROVAL_TIMEOUT_MS` | `600000` | 审批时限, 超时自动拒绝 |

| `APPROVAL_PORT` | `17650` | 审批服务端口, 只绑 127.0.0.1 |

| `QUOTA_DAILY_TOTAL` / `QUOTA_DAILY_PER_CHAT` | `50` / `20` | 群聊每日额度, 0 = 不限 |

| `SESSION_MAX_IDLE_HOURS` | `24` | 会话空闲超时, 0 = 不限 |

| \`HEALTH_PORT\` | (空) | 留空不启探针; **探针监听所有网卡且无鉴权**, 对外暴露前确认网络边界 |

| `LOG_LEVEL` | `info` | pino 日志级别 |



### **排错**



| 现象 | 处理 |
|-|-|
| 启动失败 `FEISHU_APP_SECRET is required` | 编辑 `.env` 补必填项 |
| `spawn: claude ENOENT` | `which claude` 拿绝对路径写入 `AGENT_BIN` (launchd PATH 不含 `~/.local/bin`) |

| 审批卡片收不到 | 查 \`runtime/logs/bot.log\` 的 \`approval-card: send failed\`: 错误码 \`99991672\` = 在用邮箱发卡缺 \`contact:user.id:readonly\` 权限 (见\[飞书权限列表\](#飞书权限列表)), 改配 \`APPROVAL_APPROVER_OPEN_ID\` 绕开; \`230099\`/\`200621\` = 卡片 JSON 被拒。**发卡失败默认拒绝**, 表现为所有写操作被拒 |

| 卡片按钮点了没反应 | 后台没订阅 `card.action.trigger`; 「立即配置」提示应用不存在时, 换电脑浏览器 + 确认企业主体与协作者身份 |

| 群 @ 不触发 | 查 `FEISHU_BOT_OPEN_ID` (日志 `bot open_id unresolved` 即失效); 确认没被 `ALLOWED_GROUP_CHATS` 排除 |

| `wiki-sync: fetchTree failed, keep old cache` | `lark-cli auth login` 重新登录; 失败保留旧缓存不阻断 |

| 审批卡「发起人」不显示真名 | 缺应用身份的 `contact:contact:readonly_as_app` 或数据范围未覆盖该用户 (见\[飞书权限列表\](#飞书权限列表)); 姓名结果按进程缓存, 补权限后需重启 bot |

| 发文件/语音没反应 | 预期行为, 不支持类型静默忽略 |

| 普通 kill 后进程复活 | launchd `KeepAlive` 生效, 用 `npm run stop` (内部 bootout) |



### **已知限制**



- `AGENT_STREAM` / `AGENT_PREFIX_LABEL_MODE` 仍在 env schema 里但代码未读取, 所有消息一律流式, 改了无效
- 不支持的消息类型静默忽略, 用户收不到「暂不支持」提示
- 卡片末尾的独立「来源」列表恒为空; 只有模型写在正文里的 `> 来源:` 会渲染
- 审批超时的卡片不会自动更新为终态, 仍显示「待确认」