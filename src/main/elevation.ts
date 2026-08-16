// Llama Manager Flasher — privilege detection and elevated-helper launcher.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Raw block-device writes need administrator/root rights on Windows and Linux.
// This module detects whether the current process is privileged
// (getElevationStatus) and builds the per-OS command to spawn the elevated
// HELPER process (buildHelperLaunch): Windows uses PowerShell's Start-Process
// -Verb RunAs (UAC prompt) — resolved by ABSOLUTE path under %SystemRoot% so a
// short or stripped PATH cannot make the spawn fail with ENOENT — Linux uses
// pkexec (polkit prompt). macOS needs no
// elevation: etcher-sdk opens devices through Apple's authopen(1), which
// prompts for authorization per device.
//
// The helper is spawned as a standalone SYSTEM-NODE process (not Electron):
// Electron's bundled Node cannot open raw physical-drive paths on Windows (EIO),
// while system Node opens them fine.

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

/**
 * Resolves the absolute path to Windows PowerShell 5.1.
 *
 * Spawning the bare name `powershell.exe` leaves the lookup entirely to PATH,
 * and a launch context whose PATH lacks
 * `C:\Windows\System32\WindowsPowerShell\v1.0` fails the spawn with
 * ENOENT (which previously killed the main process on startup). System32 is
 * correct here because the app ships x64 — Sysnative exists only for 32-bit
 * processes on 64-bit Windows.
 *
 * @param env - Environment to read the Windows root from (%SystemRoot%, then %windir%).
 * @returns The absolute powershell.exe path, or the bare name when neither
 *          variable is set (no worse than the previous PATH-only behaviour).
 */
function resolvePowerShell(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot?.trim() || env.windir?.trim();
  return root
    ? `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
}

/** A resolved plan for launching the helper, elevated where the OS requires it. */
export interface HelperLaunchPlan {
  command: string;
  args: string[];
  elevated: boolean;
}

/**
 * Builds the OS-specific command that starts the helper as a standalone
 * system-Node process, elevated on Windows/Linux.
 *
 * @param platform - Target platform.
 * @param opts - execPath, baseArgs (already include --helper), control port, token-file path,
 *               and optionally the environment used to locate powershell.exe (defaults to process.env).
 * @returns The command/args to spawn.
 */
export function buildHelperLaunch(
  platform: NodeJS.Platform,
  opts: {
    execPath: string;
    baseArgs: string[];
    port: number;
    tokenFile: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): HelperLaunchPlan {
  const args = [...opts.baseArgs, '--port', String(opts.port), '--token-file', opts.tokenFile];
  if (platform === 'win32') {
    // UAC via Start-Process -Verb RunAs; each arg single-quoted for the ArgumentList.
    const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(', ');
    // -WorkingDirectory anchors the elevated helper at the app root so it
    // resolves node_modules (RunAs otherwise starts it in System32).
    const workDir = opts.cwd ? ` -WorkingDirectory '${opts.cwd.replace(/'/g, "''")}'` : '';
    return {
      command: resolvePowerShell(opts.env ?? process.env),
      args: [
        '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        // -Wait keeps powershell alive for the elevated helper's whole lifetime,
        // so its exit is a faithful failure signal (UAC denied → RunAs throws →
        // non-zero exit) instead of firing the instant RunAs hands off — which
        // otherwise rejects the connection before the helper can boot + connect.
        `Start-Process -FilePath '${opts.execPath.replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden${workDir} -ArgumentList ${argList}`,
      ],
      elevated: true,
    };
  }
  if (platform === 'linux') {
    return { command: 'pkexec', args: [opts.execPath, ...args], elevated: true };
  }
  // darwin (and any other unix): no up-front elevation; authopen prompts per device.
  return { command: opts.execPath, args, elevated: false };
}
