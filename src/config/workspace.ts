import { resolve, sep } from 'node:path';

/**
 * 模型子进程跑在 `--permission-mode bypassPermissions` 下, 工作目录里的任何文件它都能读。
 * 而仓库根目录里放着 `.env` (FEISHU_APP_SECRET) 和 `user-data/runtime/sessions.json` ——
 * 一旦 WORKSPACE_DIR 落在仓库根本身或它的某个祖先目录上, 任何飞书用户都能一句话
 * 让模型把 app secret 读出来渲染进卡片。所以这是启动期硬失败, 不是告警。
 *
 * 抛错交给 index.ts 的启动失败路径 (打 stderr + 非零退出)。
 */
export function assertWorkspaceIsolated(
  workspaceDir: string,
  appRoot: string,
): void {
  const workspace = resolve(workspaceDir);
  const root = resolve(appRoot);
  const prefix = workspace.endsWith(sep) ? workspace : workspace + sep;

  if (workspace !== root && !root.startsWith(prefix)) return;

  const relation = workspace === root ? '就是本程序目录' : '是本程序目录的上级';
  throw new Error(
    `Invalid WORKSPACE_DIR: ${workspace}\n` +
      `  它${relation} (${root}); 模型会以 bypassPermissions 跑在里面, ` +
      '能直接读到 .env 里的 FEISHU_APP_SECRET 与 user-data/runtime/sessions.json。\n' +
      '  请把 WORKSPACE_DIR 指向一个独立的代码目录 (例如 /Users/you/repos/your-project)。',
  );
}
