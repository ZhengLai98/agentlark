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

/**
 * 建立飞书 WebSocket 长连接并订阅 im.message.receive_v1。
 *
 * 「started」只能由 onReady (握手真的成功) 触发: README 与人工验收清单都拿这行当
 * 存活证据, 在 start() 之后无条件打印会让 app secret 配错、事件订阅没配的进程
 * 一样报成功, 随后才甩出一个没人接的 rejection。完整的重连韧性属于 Plan 4,
 * 这里只把启动信号变诚实。
 */
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
    onReady: () => deps.logger.info('index: dispatcher started'),
    onError: (err: Error) =>
      deps.logger.fatal({ err }, 'dispatcher: websocket connection failed'),
    onReconnecting: () =>
      deps.logger.warn('dispatcher: websocket reconnecting'),
    onReconnected: () => deps.logger.info('dispatcher: websocket reconnected'),
  });

  void wsClient.start({ eventDispatcher }).catch((error: unknown) => {
    deps.logger.fatal({ err: error }, 'dispatcher: websocket start failed');
  });
}
