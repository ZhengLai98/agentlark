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
