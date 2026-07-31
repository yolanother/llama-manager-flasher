import { describe, expect, it } from 'vitest';
import { buildHelperLaunch } from '../src/main/elevation.js';

const tokenFile = 'C:\\tmp\\tok.txt';

describe('buildHelperLaunch', () => {
  it('win32: RunAs directly via powershell, no wrapper script', () => {
    const execPath = 'C:\\app\\app.exe';
    const baseArgs = ['C:\\app\\app.exe', '--helper'];
    const plan = buildHelperLaunch('win32', { execPath, baseArgs, port: 51515, tokenFile });
    expect(plan.command).toBe('powershell.exe');
    expect(plan.elevated).toBe(true);
    const argsStr = plan.args.join(' ');
    expect(argsStr).toContain('Start-Process');
    expect(argsStr).toContain('-Verb RunAs');
    expect(argsStr).toContain('--helper');
    expect(argsStr).toContain('--port');
    expect(argsStr).toContain('51515');
    expect(argsStr).toContain(tokenFile.replace(/'/g, "''"));
    expect((plan as Record<string, unknown>)['wrapperScript']).toBeUndefined();
  });

  it('linux: pkexec with execPath and baseArgs directly, no env wrapper', () => {
    const execPath = '/opt/app/electron';
    const baseArgs = ['/opt/app/electron', '--helper'];
    const plan = buildHelperLaunch('linux', { execPath, baseArgs, port: 51515, tokenFile: '/tmp/tok.txt' });
    expect(plan.command).toBe('pkexec');
    expect(plan.elevated).toBe(true);
    expect(plan.args).toEqual([
      execPath, ...baseArgs, '--port', '51515', '--token-file', '/tmp/tok.txt',
    ]);
  });

  it('darwin: spawn directly, unprivileged, no ELECTRON_RUN_AS_NODE', () => {
    const execPath = '/App/electron';
    const baseArgs = ['/App/electron', '--helper'];
    const plan = buildHelperLaunch('darwin', { execPath, baseArgs, port: 51515, tokenFile: '/tmp/tok.txt' });
    expect(plan.command).toBe(execPath);
    expect(plan.elevated).toBe(false);
    expect(plan.args).toEqual([...baseArgs, '--port', '51515', '--token-file', '/tmp/tok.txt']);
    expect((plan as Record<string, unknown>)['wrapperScript']).toBeUndefined();
    const allArgs = plan.args.join(' ');
    expect(allArgs).not.toContain('ELECTRON_RUN_AS_NODE');
  });
});
