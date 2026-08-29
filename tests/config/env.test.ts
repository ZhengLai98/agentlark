import { describe, expect, it } from 'vitest';
import { loadEnv, parseAllowedGroupChats } from '../../src/config/env';

const base = {
  FEISHU_APP_ID: 'cli_test',
  FEISHU_APP_SECRET: 'secret_test',
};

describe('loadEnv', () => {
  it('缺少 FEISHU_APP_SECRET 时抛出可读错误', () => {
    expect(() => loadEnv({ FEISHU_APP_ID: 'cli_test' })).toThrowError(
      /FEISHU_APP_SECRET/,
    );
  });

  it('缺少 FEISHU_APP_ID 时抛出可读错误', () => {
    expect(() => loadEnv({ FEISHU_APP_SECRET: 'secret_test' })).toThrowError(
      /FEISHU_APP_ID/,
    );
  });

  it('只填必填项时套用 spec 规定的默认值', () => {
    const env = loadEnv({ ...base });
    expect(env.AGENT_BIN).toBe('claude');
    expect(env.AGENT_MODEL).toBe('');
    expect(env.AGENT_TIMEOUT_MS).toBe(120000);
    expect(env.AGENT_PERMISSION_MODE).toBe('bypassPermissions');
    expect(env.AGENT_STREAM_THROTTLE_MS).toBe(500);
    expect(env.IGNORE_AT_ALL).toBe(true);
    expect(env.SESSION_MAX_IDLE_HOURS).toBe(24);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.ALLOWED_GROUP_CHATS).toBe('');
    expect(env.WORKSPACE_DIR).toBe(process.cwd());
  });

  it('数值型 env 从字符串转换', () => {
    const env = loadEnv({ ...base, AGENT_TIMEOUT_MS: '5000' });
    expect(env.AGENT_TIMEOUT_MS).toBe(5000);
  });

  it('IGNORE_AT_ALL=false 关闭忽略', () => {
    expect(loadEnv({ ...base, IGNORE_AT_ALL: 'false' }).IGNORE_AT_ALL).toBe(false);
  });

  it('拒绝非法的 AGENT_TIMEOUT_MS', () => {
    expect(() => loadEnv({ ...base, AGENT_TIMEOUT_MS: '-1' })).toThrowError(
      /AGENT_TIMEOUT_MS/,
    );
  });
});

describe('parseAllowedGroupChats', () => {
  it('留空表示允许全部群', () => {
    expect(parseAllowedGroupChats('')).toEqual([]);
    expect(parseAllowedGroupChats('  ')).toEqual([]);
  });

  it('按逗号切分并去掉空白项', () => {
    expect(parseAllowedGroupChats('oc_a, oc_b ,, oc_c')).toEqual([
      'oc_a',
      'oc_b',
      'oc_c',
    ]);
  });
});
