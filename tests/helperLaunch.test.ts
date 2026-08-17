// Llama Manager Flasher — per-OS elevated-helper launch command tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Locks the command buildHelperLaunch produces to spawn the headless helper:
// Windows spawns the interpreter DIRECTLY (the app itself is manifest-elevated,
// so the helper inherits the admin token — no PowerShell, no Start-Process
// RunAs), Linux pkexec, macOS direct/unprivileged. The win32 cases include an
// explicit regression guard that no PowerShell/RunAs machinery reappears: that
// external dependency broke drive scanning on machines without powershell.exe.
// Also covers resolveHelperNode's precedence: env override, bundled node.exe
// (packaged and dev layouts), system node, bare name.

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHelperLaunch, resolveHelperNode } from '../src/main/elevation.js';

const tokenFile = 'C:\\tmp\\tok.txt';

describe('buildHelperLaunch', () => {
  it('win32: spawns the interpreter directly with the helper args', () => {
    const execPath = 'C:\\app\\resources\\node.exe';
    const baseArgs = ['C:\\app\\resources\\app.asar\\dist\\helper\\index.js'];
    const plan = buildHelperLaunch('win32', { execPath, baseArgs, port: 51515, tokenFile });
    expect(plan.command).toBe(execPath);
    expect(plan.args).toEqual([...baseArgs, '--port', '51515', '--token-file', tokenFile]);
    // The app is elevated by its manifest, so the child inherits admin.
    expect(plan.elevated).toBe(true);
  });

  it('win32: never touches PowerShell, Start-Process or RunAs', () => {
    const plan = buildHelperLaunch('win32', {
      execPath: 'C:\\app\\node.exe',
      baseArgs: ['C:\\app\\helper.js'],
      port: 51515,
      tokenFile,
    });
    const all = [plan.command, ...plan.args].join(' ').toLowerCase();
    expect(all).not.toContain('powershell');
    expect(all).not.toContain('start-process');
    expect(all).not.toContain('runas');
    expect(all).not.toContain('system32');
  });

  it('linux: pkexec with execPath and baseArgs directly, no env wrapper', () => {
    const execPath = '/usr/bin/node';
    const baseArgs = ['/opt/app/helper.js'];
    const plan = buildHelperLaunch('linux', { execPath, baseArgs, port: 51515, tokenFile: '/tmp/tok.txt' });
    expect(plan.command).toBe('pkexec');
    expect(plan.elevated).toBe(true);
    expect(plan.args).toEqual([
      execPath, ...baseArgs, '--port', '51515', '--token-file', '/tmp/tok.txt',
    ]);
  });

  it('darwin: spawn directly, unprivileged, no ELECTRON_RUN_AS_NODE', () => {
    const execPath = '/usr/local/bin/node';
    const baseArgs = ['/App/helper.js'];
    const plan = buildHelperLaunch('darwin', { execPath, baseArgs, port: 51515, tokenFile: '/tmp/tok.txt' });
    expect(plan.command).toBe(execPath);
    expect(plan.elevated).toBe(false);
    expect(plan.args).toEqual([...baseArgs, '--port', '51515', '--token-file', '/tmp/tok.txt']);
    expect((plan as Record<string, unknown>)['wrapperScript']).toBeUndefined();
    expect(plan.args.join(' ')).not.toContain('ELECTRON_RUN_AS_NODE');
  });
});

describe('resolveHelperNode', () => {
  const never = (): boolean => false;

  it('LMF_HELPER_NODE overrides everything', () => {
    const got = resolveHelperNode({
      platform: 'win32',
      env: { LMF_HELPER_NODE: 'D:\\my\\node.exe' },
      resourcesPath: 'C:\\app\\resources',
      appRoot: 'C:\\app',
      exists: () => true,
      systemNode: () => 'C:\\other\\node.exe',
    });
    expect(got).toBe('D:\\my\\node.exe');
  });

  it('win32 packaged: prefers the bundled node.exe under resourcesPath', () => {
    // path.join uses the HOST separator, so build the expectation the same way.
    const bundled = path.join('C:\\app\\resources', 'node.exe');
    const got = resolveHelperNode({
      platform: 'win32',
      env: {},
      resourcesPath: 'C:\\app\\resources',
      appRoot: 'C:\\app\\resources\\app.asar',
      exists: (p) => p === bundled,
      systemNode: () => 'C:\\sys\\node.exe',
    });
    expect(got).toBe(bundled);
  });

  it('win32 dev checkout: falls back to build/win-node/node.exe under the app root', () => {
    const dev = path.join('/repo', 'build', 'win-node', 'node.exe');
    const got = resolveHelperNode({
      platform: 'win32',
      env: {},
      resourcesPath: undefined,
      appRoot: '/repo',
      exists: (p) => p === dev,
      systemNode: () => 'C:\\sys\\node.exe',
    });
    expect(got).toBe(dev);
  });

  it('win32: falls back to system node when the bundled copy is missing', () => {
    const got = resolveHelperNode({
      platform: 'win32',
      env: {},
      resourcesPath: 'C:\\app\\resources',
      appRoot: 'C:\\app',
      exists: never,
      systemNode: () => 'C:\\sys\\node.exe',
    });
    expect(got).toBe('C:\\sys\\node.exe');
  });

  it('win32: falls back to the bare name when nothing else resolves', () => {
    const got = resolveHelperNode({
      platform: 'win32',
      env: {},
      appRoot: 'C:\\app',
      exists: never,
      systemNode: () => null,
    });
    expect(got).toBe('node.exe');
  });

  it('linux/darwin: never look for a bundled node.exe', () => {
    const seen: string[] = [];
    const got = resolveHelperNode({
      platform: 'linux',
      env: {},
      resourcesPath: '/opt/app/resources',
      appRoot: '/opt/app',
      exists: (p) => { seen.push(p); return true; },
      systemNode: () => '/usr/bin/node',
    });
    expect(got).toBe('/usr/bin/node');
    expect(seen).toEqual([]);
    expect(resolveHelperNode({ platform: 'darwin', env: {}, appRoot: '/A', exists: never, systemNode: () => null }))
      .toBe('node');
  });
});
