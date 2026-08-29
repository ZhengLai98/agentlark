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
