import { describe, expect, it } from 'vitest';
import { buildHelperLaunch } from '../src/main/elevation.js';

const opts = {
  execPath: 'C:\\app\\electron.exe',
  helperScript: 'C:\\app\\dist\\helper\\index.js',
  port: 51515,
  tokenFile: 'C:\\tmp\\tok.txt',
  wrapperPath: 'C:\\tmp\\helper.cmd',
};

describe('buildHelperLaunch', () => {
  it('windows: RunAs a wrapper .cmd that sets ELECTRON_RUN_AS_NODE', () => {
    const plan = buildHelperLaunch('win32', opts);
    expect(plan.command).toBe('powershell.exe');
    expect(plan.elevated).toBe(true);
    expect(plan.args.join(' ')).toContain('Start-Process');
    expect(plan.args.join(' ')).toContain('-Verb RunAs');
    expect(plan.wrapperScript?.path).toBe('C:\\tmp\\helper.cmd');
    expect(plan.wrapperScript?.content).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(plan.wrapperScript?.content).toContain('51515');
    expect(plan.wrapperScript?.content).toContain('tok.txt');
  });

  it('linux: pkexec env ELECTRON_RUN_AS_NODE with the helper args', () => {
    const plan = buildHelperLaunch('linux', { ...opts, execPath: '/opt/app/electron', helperScript: '/opt/app/dist/helper/index.js', tokenFile: '/tmp/tok.txt' });
    expect(plan.command).toBe('pkexec');
    expect(plan.elevated).toBe(true);
    expect(plan.args).toEqual([
      'env', 'ELECTRON_RUN_AS_NODE=1',
      '/opt/app/electron', '/opt/app/dist/helper/index.js',
      '--port', '51515', '--token-file', '/tmp/tok.txt',
    ].map(String));
  });

  it('darwin: spawn directly, unprivileged', () => {
    const plan = buildHelperLaunch('darwin', { ...opts, execPath: '/App/electron', helperScript: '/App/dist/helper/index.js', tokenFile: '/tmp/tok.txt' });
    expect(plan.command).toBe('/App/electron');
    expect(plan.elevated).toBe(false);
    expect(plan.args).toEqual(['/App/dist/helper/index.js', '--port', '51515', '--token-file', '/tmp/tok.txt']);
    expect(plan.wrapperScript).toBeUndefined();
  });
});
