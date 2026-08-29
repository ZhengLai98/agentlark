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
