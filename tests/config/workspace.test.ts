import { describe, expect, it } from 'vitest';
import { assertWorkspaceIsolated } from '../../src/config/workspace';

const APP_ROOT = '/Users/me/code/agentlark';

describe('assertWorkspaceIsolated', () => {
  it('独立目录放行', () => {
    expect(() =>
      assertWorkspaceIsolated('/Users/me/repos/web-main', APP_ROOT),
    ).not.toThrow();
  });

  it('仓库根自身被拒 (.env 会落进 bypassPermissions 沙箱)', () => {
    expect(() => assertWorkspaceIsolated(APP_ROOT, APP_ROOT)).toThrowError(
      /WORKSPACE_DIR/,
    );
    expect(() => assertWorkspaceIsolated(APP_ROOT, APP_ROOT)).toThrowError(
      /FEISHU_APP_SECRET/,
    );
  });

  it('仓库根的祖先目录被拒', () => {
    expect(() => assertWorkspaceIsolated('/Users/me/code', APP_ROOT)).toThrow();
    expect(() => assertWorkspaceIsolated('/Users/me', APP_ROOT)).toThrow();
    expect(() => assertWorkspaceIsolated('/', APP_ROOT)).toThrow();
  });

  it('相对路径先归一化再比较', () => {
    expect(() => assertWorkspaceIsolated('.', process.cwd())).toThrow();
    expect(() => assertWorkspaceIsolated('..', process.cwd())).toThrow();
  });

  it('仓库根的子目录不受限 (不是本次要挡的方向)', () => {
    expect(() =>
      assertWorkspaceIsolated(`${APP_ROOT}/playground`, APP_ROOT),
    ).not.toThrow();
  });

  it('同前缀但不同目录的兄弟目录放行', () => {
    expect(() =>
      assertWorkspaceIsolated('/Users/me/code/agentlark-workspace', APP_ROOT),
    ).not.toThrow();
  });
});
