import { describe, expect, it } from 'vitest';
import { buildAgentArgs } from '../../src/agent/args';

describe('buildAgentArgs', () => {
  it('总是以 headless + stream-json 模式运行', () => {
    const args = buildAgentArgs({ model: '', permissionMode: 'bypassPermissions' });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('prompt 不进 argv (改走 stdin, 避免超长与转义问题)', () => {
    const args = buildAgentArgs({ model: '', permissionMode: 'default' });
    expect(args.some((a) => a.includes('帮我'))).toBe(false);
  });

  it('AGENT_MODEL 为空时不传 --model, 由 ~/.claude/settings.json 决定', () => {
    const args = buildAgentArgs({ model: '', permissionMode: 'default' });
    expect(args).not.toContain('--model');
  });

  it('配置了模型时传 --model', () => {
    const args = buildAgentArgs({
      model: 'claude-opus-5',
      permissionMode: 'default',
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5');
  });

  it('有 sessionId 时续接会话', () => {
    const args = buildAgentArgs({
      model: '',
      permissionMode: 'default',
      resumeSessionId: 'sess_abc',
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess_abc');
  });

  it('没有 sessionId 时不传 --resume', () => {
    expect(
      buildAgentArgs({ model: '', permissionMode: 'default' }),
    ).not.toContain('--resume');
  });
});
