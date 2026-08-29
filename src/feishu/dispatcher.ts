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
