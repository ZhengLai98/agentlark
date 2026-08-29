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
  /**
   * 终态: 把卡片 patch 成完整答案。
   * @returns 是否真的送达; false 表示终态 patch 与续传新卡都失败了,
   * 卡片会永远停在「思考中」—— 调用方必须退回纯文本把答案发出去。
   */
  finalize(text: string): Promise<boolean>;
  /** 失败终态: 红色卡片 + 可读错误。返回值语义同 finalize。 */
  fail(text: string): Promise<boolean>;
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

  /**
   * 刷一帧卡片。
   * @param terminal 是不是终态那一帧 —— 只影响日志口径: 中途失败的内容会随下一次
   * patch 一起补发 (state 是累积的), 终态失败则真的丢了。
   * @returns 内容是否送达 (patch 成功, 或续传新卡成功)。
   */
  const flushOnce = async (terminal: boolean): Promise<boolean> => {
    const content = JSON.stringify(renderCard(state).card);
    try {
      await deps.api.patchMessage({ messageId: cardMessageId, content });
      consecutiveFailures = 0;
      return true;
    } catch (error) {
      consecutiveFailures += 1;
      deps.logger.warn(
        { err: error, cardMessageId, consecutiveFailures },
        'stream-card: patch failed',
      );

      if (consecutiveFailures < MAX_PATCH_FAILURES) return false;

      try {
        cardMessageId = await sendCard();
        consecutiveFailures = 0;
        deps.logger.info(
          { cardMessageId },
          'stream-card: continued on a new card',
        );
        return true;
      } catch (resendError) {
        consecutiveFailures = 0;
        if (terminal) {
          deps.logger.error(
            { err: resendError },
            'stream-card: terminal resend failed, answer lost on card',
          );
        } else {
          deps.logger.warn(
            { err: resendError },
            'stream-card: resend failed, progress deferred to the next patch',
          );
        }
        return false;
      }
    }
  };

  const throttled = createThrottle<null>(deps.throttleMs, async () => {
    await flushOnce(false);
  });

  const settle = async (text: string, failed: boolean): Promise<boolean> => {
    state.answer = text;
    state.failed = failed;
    closed = true;
    await throttled.flush();
    return flushOnce(true);
  };

  return {
    addProgress(line: string): void {
      if (closed) return;
      state.progress.push(line);
      throttled.push(null);
    },
    finalize(text: string): Promise<boolean> {
      return settle(text, false);
    },
    fail(text: string): Promise<boolean> {
      return settle(text, true);
    },
  };
}
