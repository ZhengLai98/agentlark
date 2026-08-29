import { describe, expect, it } from 'vitest';
import {
  loadEnv,
  parseAllowedGroupChats,
  parseAllowedUsers,
} from '../../src/config/env';

const base = {
  FEISHU_APP_ID: 'cli_test',
  FEISHU_APP_SECRET: 'secret_test',
  WORKSPACE_DIR: '/Users/me/repos/web-main',
};

describe('loadEnv', () => {
  it('缺少 FEISHU_APP_SECRET 时抛出可读错误', () => {
    expect(() =>
      loadEnv({ ...base, FEISHU_APP_SECRET: undefined }),
    ).toThrowError(/FEISHU_APP_SECRET/);
  });

  it('缺少 FEISHU_APP_ID 时抛出可读错误', () => {
    expect(() => loadEnv({ ...base, FEISHU_APP_ID: undefined })).toThrowError(
      /FEISHU_APP_ID/,
    );
  });

  // 刻意没有默认值: 默认成 cwd 会把带 .env 的仓库根塞进 bypassPermissions 沙箱
  it('缺少 WORKSPACE_DIR 时抛出可读错误 (不再默认成 cwd)', () => {
    expect(() => loadEnv({ ...base, WORKSPACE_DIR: undefined })).toThrowError(
      /WORKSPACE_DIR/,
    );
    expect(() => loadEnv({ ...base, WORKSPACE_DIR: '' })).toThrowError(
      /WORKSPACE_DIR/,
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
    expect(env.ALLOWED_USERS).toBe('');
    expect(env.WORKSPACE_DIR).toBe('/Users/me/repos/web-main');
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

describe('parseAllowedUsers', () => {
  it('留空表示允许全部人 (与群白名单口径一致)', () => {
    expect(parseAllowedUsers('')).toEqual([]);
    expect(parseAllowedUsers('  ')).toEqual([]);
  });

  it('按逗号切分并去掉空白项', () => {
    expect(parseAllowedUsers('ou_a, ou_b ,, ou_c')).toEqual([
      'ou_a',
      'ou_b',
      'ou_c',
    ]);
  });
});
