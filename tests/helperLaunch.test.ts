// Llama Manager Flasher — per-OS elevated-helper launch command tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Locks the command buildHelperLaunch produces to spawn the headless helper:
// Windows RunAs (with -Wait so the launcher can detect denial), Linux pkexec,
// macOS direct/unprivileged. Also pins how PowerShell is resolved on Windows —
// an absolute SystemRoot/windir path rather than a bare name, so a short PATH
// cannot make the spawn fail with ENOENT.

import { describe, expect, it } from 'vitest';
import { buildHelperLaunch } from '../src/main/elevation.js';

const tokenFile = 'C:\\tmp\\tok.txt';

describe('buildHelperLaunch', () => {
  it('win32: RunAs directly via powershell, no wrapper script', () => {
    const execPath = 'C:\\app\\app.exe';
    const baseArgs = ['C:\\app\\app.exe', '--helper'];
    const env = { SystemRoot: 'C:\\WINDOWS' };
    const plan = buildHelperLaunch('win32', { execPath, baseArgs, port: 51515, tokenFile, env });
    expect(plan.command).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(plan.elevated).toBe(true);
    const argsStr = plan.args.join(' ');
    expect(argsStr).toContain('Start-Process');
    expect(argsStr).toContain('-Verb RunAs');
    expect(argsStr).toContain('-Wait');
    expect(argsStr).toContain('--helper');
    expect(argsStr).toContain('--port');
    expect(argsStr).toContain('51515');
    expect(argsStr).toContain(tokenFile.replace(/'/g, "''"));
    expect((plan as Record<string, unknown>)['wrapperScript']).toBeUndefined();
  });

  it('win32: falls back to windir when SystemRoot is unset', () => {
    const plan = buildHelperLaunch('win32', {
      execPath: 'C:\\app\\app.exe',
      baseArgs: ['C:\\app\\app.exe', '--helper'],
      port: 51515,
      tokenFile,
      env: { windir: 'D:\\Windows' },
    });
    expect(plan.command).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('win32: falls back to the bare powershell.exe name when neither root is set', () => {
    const plan = buildHelperLaunch('win32', {
      execPath: 'C:\\app\\app.exe',
      baseArgs: ['C:\\app\\app.exe', '--helper'],
      port: 51515,
      tokenFile,
      env: {},
    });
    expect(plan.command).toBe('powershell.exe');
  });

  it('win32: never uses Sysnative — the app ships x64', () => {
    const plan = buildHelperLaunch('win32', {
      execPath: 'C:\\app\\app.exe',
      baseArgs: ['C:\\app\\app.exe', '--helper'],
      port: 51515,
      tokenFile,
      env: { SystemRoot: 'C:\\WINDOWS', windir: 'C:\\WINDOWS' },
    });
    expect(plan.command).not.toContain('Sysnative');
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
