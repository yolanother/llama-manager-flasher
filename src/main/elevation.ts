// Llama Manager Flasher — privilege detection and elevated-helper launcher.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Raw block-device writes need administrator/root rights on Windows and Linux.
// This module detects whether the current process is privileged
// (getElevationStatus) and builds the per-OS command to spawn the elevated
// HELPER process (buildHelperLaunch): Windows uses PowerShell's Start-Process
// -Verb RunAs (UAC prompt), Linux uses pkexec (polkit prompt). macOS needs no
// elevation: etcher-sdk opens devices through Apple's authopen(1), which
// prompts for authorization per device.

import { spawnSync } from 'node:child_process';

/** Elevation status reported to the renderer. */
export interface ElevationStatus {
  /** True when the process can already open raw block devices. */
  elevated: boolean;
  /** The current OS platform. */
  platform: NodeJS.Platform;
  /** True when this module can relaunch the app with elevation. */
  canRelaunch: boolean;
  /** Manual instruction shown when automatic relaunch is unavailable. */
  manualHint: string | null;
}

/**
 * Determines whether the current process is privileged enough to write raw
 * block devices on this OS.
 *
 * - linux: euid 0.
 * - win32: probes `fltmc` (succeeds only in an elevated process).
 * - darwin: always true — etcher-sdk elevates per-device via authopen(1).
 *
 * @returns The elevation status for the current process.
 */
export function getElevationStatus(): ElevationStatus {
  const platform = process.platform;
  if (platform === 'darwin') {
    return {
      elevated: true,
      platform,
      canRelaunch: false,
      manualHint: null,
    };
  }
  if (platform === 'win32') {
    const probe = spawnSync('fltmc', [], { stdio: 'ignore', shell: true });
    const elevated = probe.status === 0;
    return { elevated, platform, canRelaunch: !elevated, manualHint: null };
  }
  // linux and other unixes
  const elevated = typeof process.geteuid === 'function' && process.geteuid() === 0;
  const hasPkexec = spawnSync('which', ['pkexec'], { stdio: 'ignore' }).status === 0;
  return {
    elevated,
    platform,
    canRelaunch: !elevated && hasPkexec,
    manualHint: elevated || hasPkexec
      ? null
      : `pkexec is not installed — close the app and rerun it with: sudo ${appLaunchPath()}`,
  };
}

/**
 * Resolves the path a user (or elevated relaunch) should execute to start
 * this app again: the original AppImage / portable exe when packaged, or the
 * raw Electron binary in development.
 *
 * @returns The absolute launch path.
 */
function appLaunchPath(): string {
  return (
    process.env.APPIMAGE ?? // AppImage runtime sets this to the .AppImage path
    process.env.PORTABLE_EXECUTABLE_FILE ?? // electron-builder portable target
    process.execPath
  );
}

/** A resolved plan for launching the helper, elevated where the OS requires it. */
export interface HelperLaunchPlan {
  command: string;
  args: string[];
  elevated: boolean;
  wrapperScript?: { path: string; content: string };
}

/**
 * Builds the OS-specific command that starts the headless helper as a Node
 * process (Electron run with ELECTRON_RUN_AS_NODE), elevated on Windows/Linux.
 *
 * @param platform - Target platform.
 * @param opts - Absolute paths, the control port, and the token-file path.
 * @returns The command/args to spawn (plus a wrapper script on Windows).
 */
export function buildHelperLaunch(
  platform: NodeJS.Platform,
  opts: { execPath: string; helperScript: string; port: number; tokenFile: string; wrapperPath: string },
): HelperLaunchPlan {
  const helperArgs = [opts.helperScript, '--port', String(opts.port), '--token-file', opts.tokenFile];
  if (platform === 'win32') {
    const content = [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${opts.execPath}" "${opts.helperScript}" --port ${opts.port} --token-file "${opts.tokenFile}"`,
      '',
    ].join('\r\n');
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Start-Process -FilePath '${opts.wrapperPath.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden`,
      ],
      elevated: true,
      wrapperScript: { path: opts.wrapperPath, content },
    };
  }
  if (platform === 'linux') {
    return {
      command: 'pkexec',
      args: ['env', 'ELECTRON_RUN_AS_NODE=1', opts.execPath, ...helperArgs],
      elevated: true,
    };
  }
  // darwin (and any other unix): no up-front elevation; authopen prompts per device.
  return { command: opts.execPath, args: helperArgs, elevated: false };
}
