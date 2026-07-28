// Llama Manager Flasher — privilege detection and self-elevation.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Raw block-device writes need administrator/root rights on Windows and
// Linux. This module detects whether the current process is privileged and,
// when it is not, relaunches the app elevated: Windows uses PowerShell's
// Start-Process -Verb RunAs (UAC prompt), Linux uses pkexec (polkit prompt,
// forwarding DISPLAY/XAUTHORITY/WAYLAND_DISPLAY so the GUI still opens) with
// a sudo instruction as the fallback when pkexec is absent. macOS needs no
// relaunch: etcher-sdk opens devices through Apple's authopen(1), which
// prompts for authorization per device.

import { spawn, spawnSync } from 'node:child_process';

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
 * Relaunches the app with elevated privileges and quits the current
 * (unprivileged) instance on success.
 *
 * @param quit - Callback that quits the current app instance (app.quit).
 * @throws {Error} When the platform has no automatic elevation path.
 */
export function relaunchElevated(quit: () => void): void {
  const target = appLaunchPath();
  if (process.platform === 'win32') {
    // UAC prompt via the runas verb. -WindowStyle Hidden hides the transient
    // PowerShell host window, not the app.
    const psArgs = [
      '-NoProfile',
      '-WindowStyle', 'Hidden',
      '-Command',
      `Start-Process -FilePath '${target.replace(/'/g, "''")}' -Verb RunAs`,
    ];
    spawn('powershell.exe', psArgs, { detached: true, stdio: 'ignore' }).unref();
    setTimeout(quit, 500);
    return;
  }
  if (process.platform === 'linux') {
    // pkexec strips the environment; forward what the GUI needs and disable
    // Chromium's sandbox (required when running as root).
    const envArgs = ['env'];
    for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
      const value = process.env[key];
      if (value) envArgs.push(`${key}=${value}`);
    }
    spawn('pkexec', [...envArgs, target, '--no-sandbox'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    setTimeout(quit, 500);
    return;
  }
  throw new Error(`automatic elevation is not supported on ${process.platform}`);
}
