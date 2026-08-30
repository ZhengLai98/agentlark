import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleMessageEvent,
  startDispatcher,
} from '../../src/feishu/dispatcher';
import type { ParsedMessage } from '../../src/types/feishu';

const { wsInstances, wsState } = vi.hoisted(() => ({
  wsInstances: [] as Array<{ params: any; start: ReturnType<typeof vi.fn> }>,
  wsState: { startRejection: null as Error | null },
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class WSClient {
    start = vi.fn(() =>
      wsState.startRejection
        ? Promise.reject(wsState.startRejection)
        : Promise.resolve(),
    );
    constructor(readonly params: any) {
      wsInstances.push(this as never);
    }
  }
  class EventDispatcher {
    register = vi.fn().mockReturnThis();
  }
  return { WSClient, EventDispatcher, Domain: { Feishu: 'feishu' } };
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
};

const rawTextEvent = {
  sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
  message: {
    message_id: 'om_1',
    root_id: '',
    parent_id: '',
    create_time: '1700000000000',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '你好' }),
    mentions: [],
  },
};

describe('handleMessageEvent', () => {
  it('解析成功时把 ParsedMessage 交给 onMessage', () => {
    const seen: ParsedMessage[] = [];
    handleMessageEvent(rawTextEvent, logger as never, (m) => seen.push(m));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messageId).toBe('om_1');
  });

  it('不支持的类型静默丢弃, 不调 onMessage', () => {
    const onMessage = vi.fn();
    handleMessageEvent(
      {
        ...rawTextEvent,
        message: { ...rawTextEvent.message, message_type: 'file' },
      },
      logger as never,
      onMessage,
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('onMessage 抛错被吞掉, 不冒泡到 SDK 的事件循环', () => {
    expect(() =>
      handleMessageEvent(rawTextEvent, logger as never, () => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });
});

describe('startDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsInstances.length = 0;
    wsState.startRejection = null;
  });

  const start = () =>
    startDispatcher({
      appId: 'cli_test',
      appSecret: 'secret',
      logger: logger as never,
      onMessage: vi.fn(),
    });

  it('握手成功前不打 started, onReady 才打', () => {
    start();
    expect(logger.info).not.toHaveBeenCalledWith('index: dispatcher started');

    wsInstances[0]!.params.onReady();
    expect(logger.info).toHaveBeenCalledWith('index: dispatcher started');
  });

  it('连接失败记 fatal', () => {
    start();
    wsInstances[0]!.params.onError(new Error('invalid app secret'));
    expect(logger.fatal).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith('index: dispatcher started');
  });

  it('重连过程记 warn / info', () => {
    start();
    wsInstances[0]!.params.onReconnecting();
    expect(logger.warn).toHaveBeenCalledWith('dispatcher: websocket reconnecting');
    wsInstances[0]!.params.onReconnected();
    expect(logger.info).toHaveBeenCalledWith('dispatcher: websocket reconnected');
  });

  it('订阅时把 eventDispatcher 交给 start()', () => {
    start();
    expect(wsInstances[0]!.start).toHaveBeenCalledWith(
      expect.objectContaining({ eventDispatcher: expect.anything() }),
    );
  });

  it('start() 的 rejection 被接住并记 fatal, 不变成 unhandledRejection', async () => {
    const boom = new Error('boom');
    wsState.startRejection = boom;

    expect(() => start()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.fatal).toHaveBeenCalledWith(
      { err: boom },
      'dispatcher: websocket start failed',
    );
  });
});
