import { describe, expect, it } from 'vitest';
import { buildChildEnv } from '../../src/agent/child-env';

describe('buildChildEnv', () => {
  it('保留白名单内的变量', () => {
    const env = buildChildEnv({ PATH: '/usr/bin', HOME: '/Users/me' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/me');
  });

  it('剔除飞书凭据等敏感变量', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      FEISHU_APP_SECRET: 'secret',
      FEISHU_APP_ID: 'cli_x',
      SENSORS_COOKIE: 'c',
      AWS_SECRET_ACCESS_KEY: 'k',
    });
    expect(env.FEISHU_APP_SECRET).toBeUndefined();
    expect(env.FEISHU_APP_ID).toBeUndefined();
    expect(env.SENSORS_COOKIE).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('剔除未列入白名单的任意变量', () => {
    expect(buildChildEnv({ PATH: '/usr/bin', RANDOM_THING: 'x' }).RANDOM_THING)
      .toBeUndefined();
  });

  it('白名单里未设置的变量不会凭空出现', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' });
    expect('TMPDIR' in env).toBe(false);
  });
});
