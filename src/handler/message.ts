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

const READABLE_FAILURE =
  '处理这条消息时出错了, 请稍后再试。详情见 runtime/logs/bot.log。';

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
  /**
   * 把终态正文交付给用户。卡片报告没送达 (终态 patch 与续传都失败) 时退回纯文本,
   * 否则用户会盯着「💭 思考中」等一个已经算出来的答案。
   */
  const deliver = async (
    msg: ParsedMessage,
    card: StreamCardHandle | null,
    text: string,
    failed: boolean,
  ): Promise<void> => {
    if (!card) {
      await deps.reply(msg, text);
      return;
    }

    const delivered = failed ? await card.fail(text) : await card.finalize(text);
    if (delivered) return;

    deps.logger.warn(
      { chatId: msg.chatId },
      'message: card delivery failed, falling back to plain text',
    );
    await deps.reply(msg, text);
  };

  return async (msg) => {
    // 表情回执是尽力而为, 失败不影响回答
    await deps.react(msg.messageId).catch(() => undefined);

    const key = sessionKey(msg);

    const command = matchCommand(msg.text);
    if (command) {
      // 指令分支同样要包在错误处理里: sessions.clear 会同步写盘,
      // 磁盘满/权限问题会一路抛穿流水线, 最终把整个进程带走。
      try {
        switch (command.kind) {
          case 'reset':
            deps.sessions.clear(key);
            await deps.reply(msg, RESET_REPLY);
            break;
          case 'whoami':
            await deps.reply(
              msg,
              msg.chatType === 'group'
                ? WHOAMI_GROUP_HINT
                : `你的 open_id: ${msg.senderOpenId}`,
            );
            break;
          case 'canned':
            await deps.reply(msg, command.text);
            break;
        }
      } catch (error) {
        deps.logger.error(
          { err: error, chatId: msg.chatId },
          'message: command failed',
        );
        await deps.reply(msg, READABLE_FAILURE);
      }
      return;
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

      if (!result.ok) {
        deps.logger.warn({ chatId: msg.chatId }, 'message: agent reported failure');
        await deliver(msg, card, result.text, true);
        return;
      }

      // 先交付再落盘: 会话持久化是下一轮的事, 不该让一次 fs 抛错吃掉已经算出来的答案
      await deliver(msg, card, result.text, false);
      try {
        deps.sessions.set(key, result.sessionId);
      } catch (error) {
        deps.logger.error(
          { err: error, chatId: msg.chatId },
          'message: persist session failed, context will not resume',
        );
      }
    } catch (error) {
      deps.logger.error({ err: error, chatId: msg.chatId }, 'message: pipeline failed');
      await deliver(msg, card, READABLE_FAILURE, true);
    }
  };
}
