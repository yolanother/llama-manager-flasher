// Llama Manager Flasher — privilege detection and helper-launch resolution.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Raw block-device writes need administrator/root rights on Windows and Linux.
// This module detects whether the current process is privileged
// (getElevationStatus), resolves the Node interpreter that runs the helper
// (resolveHelperNode), and builds the per-OS command to spawn it
// (buildHelperLaunch).
//
// Windows requires NO elevation step here: the packaged exe carries a
// `requireAdministrator` manifest, so the whole app is already elevated by the
// time it runs and the helper simply inherits the admin token through a plain
// CreateProcess spawn. (This is why the old PowerShell `Start-Process -Verb
// RunAs` path is gone — CreateProcess cannot raise privileges, only
// ShellExecuteEx can, and PowerShell was merely a way to reach it. It was also
// an undeclared runtime dependency that failed with ENOENT on machines without
// powershell.exe.) Linux still uses pkexec (polkit prompt). macOS needs no
// elevation: etcher-sdk opens devices through Apple's authopen(1), which
// prompts for authorization per device.
//
// The helper is spawned as a standalone NODE process (not Electron): Electron's
// bundled Node cannot open raw physical-drive paths on Windows (EIO), while
// stock Node opens them fine. On Windows the app ships its own pinned node.exe
// so no system Node install is required.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Elevation status reported to the renderer. */
export interface ElevationStatus {
  /** True when the process can already open raw block devices. */
  elevated: boolean;
  /** The current OS platform. */
  platform: NodeJS.Platform;
  /** Manual instruction shown when the process is NOT privileged. */
  manualHint: string | null;
}

/**
 * Determines whether the current process is privileged enough to write raw
 * block devices on this OS.
 *
 * - linux: euid 0.
 * - win32: probes `fltmc` (succeeds only in an elevated process). The packaged
 *   exe requests administrator in its manifest, so this normally reports true;
 *   a false here means the manifest did not take effect.
 * - darwin: always true — etcher-sdk elevates per-device via authopen(1).
 *
 * @returns The elevation status for the current process.
 */
export function getElevationStatus(): ElevationStatus {
  const platform = process.platform;
  if (platform === 'darwin') {
    return { elevated: true, platform, manualHint: null };
  }
  if (platform === 'win32') {
    const probe = spawnSync('fltmc', [], { stdio: 'ignore', shell: true });
    const elevated = probe.status === 0;
    return {
      elevated,
      platform,
      manualHint: elevated
        ? null
        : 'This app must run as administrator. Close it, right-click '
          + `${path.basename(appLaunchPath())} and choose "Run as administrator".`,
    };
  }
  // linux and other unixes
  const elevated = typeof process.geteuid === 'function' && process.geteuid() === 0;
  const hasPkexec = spawnSync('which', ['pkexec'], { stdio: 'ignore' }).status === 0;
  return {
    elevated,
    platform,
    manualHint: elevated || hasPkexec
      ? null
      : `pkexec is not installed — close the app and rerun it with: sudo ${appLaunchPath()}`,
  };
}

/**
 * Resolves the path a user should execute to start this app again: the
 * original AppImage / portable exe when packaged, or the raw Electron binary
 * in development.
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

/** Inputs for {@link resolveHelperNode}; injectable so the logic is testable. */
export interface HelperNodeLookup {
  /** Target platform (only win32 ships a bundled interpreter). */
  platform: NodeJS.Platform;
  /** Environment to read the LMF_HELPER_NODE override from. */
  env: NodeJS.ProcessEnv;
  /** Electron's `process.resourcesPath` when packaged; undefined otherwise. */
  resourcesPath?: string;
  /** App root in a dev checkout (the repo root that holds build/win-node). */
  appRoot: string;
  /** Existence probe (defaults to fs.existsSync). */
  exists?: (p: string) => boolean;
  /** Locates an installed Node, or null (defaults to a PATH lookup). */
  systemNode?: () => string | null;
}

/**
 * Locates a Node interpreter that can open raw physical drives, preferring the
 * copy we ship so the app has no external runtime dependency on Windows.
 *
 * Precedence: `LMF_HELPER_NODE` (dev override) → the bundled node.exe (packaged
 * under `process.resourcesPath`, or `build/win-node/` in a dev checkout) →
 * an installed Node found on PATH → the bare interpreter name. The last two
 * steps preserve the pre-bundling behaviour, so a missing bundled copy is never
 * worse than before.
 *
 * @param o - Platform, environment and path inputs; see {@link HelperNodeLookup}.
 * @returns The interpreter path (or bare name) to spawn the helper with.
 */
export function resolveHelperNode(o: HelperNodeLookup): string {
  const override = o.env.LMF_HELPER_NODE?.trim();
  if (override) return override;

  const exists = o.exists ?? existsSync;
  if (o.platform === 'win32') {
    const candidates = [
      // Packaged: extraResources drops node.exe beside app.asar.
      ...(o.resourcesPath ? [path.join(o.resourcesPath, 'node.exe')] : []),
      // Dev checkout: fetched by scripts/fetch-win-node.cjs.
      path.join(o.appRoot, 'build', 'win-node', 'node.exe'),
    ];
    const bundled = candidates.find(exists);
    if (bundled) return bundled;
  }

  const system = (o.systemNode ?? findSystemNode)();
  if (system) return system;
  return o.platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * Looks up an installed Node interpreter on PATH.
 *
 * @returns The first match, or null when the lookup fails or finds nothing.
 */
function findSystemNode(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'command -v node';
    const r = spawnSync(cmd, { encoding: 'utf8', shell: true });
    if (r.status !== 0) return null;
    return (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/** A resolved plan for launching the helper, elevated where the OS requires it. */
export interface HelperLaunchPlan {
  command: string;
  args: string[];
  /**
   * True when the spawned helper runs privileged. On win32 that comes from the
   * app's own `requireAdministrator` manifest (the child inherits the token);
   * on linux from pkexec.
   */
  elevated: boolean;
}

/**
 * Builds the OS-specific command that starts the helper as a standalone Node
 * process, privileged where the OS requires it.
 *
 * @param platform - Target platform.
 * @param opts - execPath (the Node interpreter), baseArgs (the helper script),
 *               the control port and the token-file path.
 * @returns The command/args to spawn.
 */
export function buildHelperLaunch(
  platform: NodeJS.Platform,
  opts: {
    execPath: string;
    baseArgs: string[];
    port: number;
    tokenFile: string;
  },
): HelperLaunchPlan {
  const args = [...opts.baseArgs, '--port', String(opts.port), '--token-file', opts.tokenFile];
  if (platform === 'win32') {
    // No UAC step: the app is already elevated by its manifest, so a plain
    // CreateProcess spawn hands the admin token straight to the helper.
    return { command: opts.execPath, args, elevated: true };
  }
  if (platform === 'linux') {
    return { command: 'pkexec', args: [opts.execPath, ...args], elevated: true };
  }
  // darwin (and any other unix): no up-front elevation; authopen prompts per device.
  return { command: opts.execPath, args, elevated: false };
}
