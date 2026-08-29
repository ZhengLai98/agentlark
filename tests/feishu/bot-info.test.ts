import { describe, expect, it, vi } from 'vitest';
import { resolveBotOpenId } from '../../src/feishu/bot-info';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('resolveBotOpenId', () => {
  it('配置了 FEISHU_BOT_OPEN_ID 时直接返回, 不发请求', async () => {
    const api = { getBotOpenId: vi.fn() };
    await expect(
      resolveBotOpenId(api as never, 'ou_configured', logger as never),
    ).resolves.toBe('ou_configured');
    expect(api.getBotOpenId).not.toHaveBeenCalled();
  });

  it('未配置时调 bot/v3/info 解析', async () => {
    const api = { getBotOpenId: vi.fn().mockResolvedValue('ou_resolved') };
    await expect(
      resolveBotOpenId(api as never, '', logger as never),
    ).resolves.toBe('ou_resolved');
  });

  it('解析失败返回空串并告警, 不抛错阻断启动', async () => {
    const warn = vi.fn();
    const api = {
      getBotOpenId: vi.fn().mockRejectedValue(new Error('network down')),
    };
    await expect(
      resolveBotOpenId(api as never, '', { ...logger, warn } as never),
    ).resolves.toBe('');
    expect(warn).toHaveBeenCalled();
  });
});
