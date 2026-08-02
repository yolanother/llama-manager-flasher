// Llama Manager Flasher — privileged device agent (scan + flash via etcher-sdk).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Runs ONLY inside the elevated system-Node helper. Owns the sole import of
// etcher-sdk and re-checks every safety rail (removable-only, size cap,
// re-enumerate-and-match) at the privileged boundary before any raw write.
//
// The scanner is started ONCE and kept alive for the helper's lifetime: its
// drive list updates live on attach/detach, so both repeated scans and the
// pre-write re-match read a fresh list without the native churn (and hangs)
// caused by constructing/starting/stopping a new Scanner on every request.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { driveRejectionReason } from '../shared/deviceSafety.js';
import {
  buildScanResult,
  normalizeDriveCandidate,
  waitForScannerReady,
  type DriveScanResult,
  type ScannerLike,
} from '../main/driveScanner.js';
import { getElevationStatus } from '../main/elevation.js';
import type { HelperFlashProgress } from '../shared/helperProtocol.js';

/**
 * Prepares a Windows physical disk for a raw write: clears any read-only
 * attribute and wipes the partition table (dismounting its volumes) WITHOUT
 * the trailing `rescan` etcher-sdk's own clean issues — the rescan re-triggers
 * the volume manager to re-lock the disk. No-op off Windows.
 */
async function prepareWindowsDisk(devicePath: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const match = devicePath.match(/PhysicalDrive(\d+)/i);
  if (!match) return;
  const scriptPath = path.join(os.tmpdir(), `lmf-diskprep-${match[1]}-${process.pid}.txt`);
  await fs.writeFile(scriptPath, [`select disk ${match[1]}`, 'attributes disk clear readonly', 'clean', ''].join('\r\n'));
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('diskpart', ['/s', scriptPath], { windowsHide: true }, (err, out) => {
        if (err) reject(new Error(`diskpart failed: ${err.message}\n${out}`));
        else resolve();
      });
    });
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

/** Single long-lived scanner, started once and reused across all requests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scannerPromise: Promise<any> | null = null;

/**
 * Returns the shared, already-started etcher-sdk Scanner, constructing and
 * starting it on first use. On a start failure the cache is cleared so the
 * next caller retries rather than being stuck with a half-open scanner.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getScanner(): Promise<any> {
  if (!scannerPromise) {
    scannerPromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = (await import('etcher-sdk')) as any;
      const scanner = new sdk.scanner.Scanner([
        new sdk.scanner.adapters.BlockDeviceAdapter({ includeSystemDrives: () => false }),
      ]);
      await waitForScannerReady(scanner as ScannerLike);
      return scanner;
    })().catch((err: unknown) => {
      scannerPromise = null;
      throw err;
    });
  }
  return scannerPromise;
}

/** Enumerates safe removable block devices from the shared scanner. */
export async function scanDevices(): Promise<DriveScanResult> {
  const scanner = await getScanner();
  return buildScanResult(Array.from(scanner.drives.values()), {
    elevated: getElevationStatus().elevated,
    readyMs: 0,
  });
}

/** Writes and verifies an image to a re-matched, safety-checked device. */
export async function flashDevice(
  args: { devicePath: string; imagePath: string; typedConfirmation: string },
  onProgress: (p: HelperFlashProgress) => void,
): Promise<{ ok: boolean }> {
  if (args.typedConfirmation !== args.devicePath) {
    throw new Error('confirmation text does not match the selected device');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (await import('etcher-sdk')) as any;
  const { sourceDestination, multiWrite } = sdk;

  const source: unknown = args.imagePath.endsWith('.xz')
    ? new sourceDestination.XzSource(new sourceDestination.File({ path: args.imagePath }))
    : new sourceDestination.File({ path: args.imagePath });

  // Re-enumerate-and-match against the live shared scanner (never renderer input).
  const scanner = await getScanner();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target = Array.from(scanner.drives.values() as Iterable<any>)
    .find((d) => d.device === args.devicePath);
  if (!target) {
    throw new Error(`device ${args.devicePath} not found — was it unplugged?`);
  }

  const normalizedTarget = normalizeDriveCandidate(target);
  const rejection = normalizedTarget == null
    ? 'missing device path — cannot safely identify the target'
    : driveRejectionReason(normalizedTarget);
  if (rejection) {
    throw new Error(`refusing to flash ${args.devicePath}: ${rejection}`);
  }

  // Clean the disk ourselves (clean WITHOUT rescan), then tell etcher-sdk to
  // skip its own clean+rescan via keepOriginal so the write open isn't raced by
  // a fresh volume-manager lock.
  await prepareWindowsDisk(args.devicePath);

  const writer = new sourceDestination.BlockDevice({
    drive: target, unmountOnSuccess: true, write: true, direct: false, keepOriginal: true,
  });

  const result = await multiWrite.pipeSourceToDestinations({
    source,
    destinations: [writer],
    verify: true,
    trim: false,
    onProgress: (p: { type: string; bytesWritten?: number; size?: number; speed?: number; percentage?: number }) => {
      onProgress({
        phase: p.type,
        bytesWritten: p.bytesWritten ?? 0,
        size: p.size ?? 0,
        speed: p.speed ?? 0,
        percentage: p.percentage ?? 0,
      });
    },
    onFail: (_dest: unknown, err: Error) => {
      onProgress({ phase: 'failed', bytesWritten: 0, size: 0, speed: 0, percentage: 0, error: err.message });
    },
  });
  return { ok: result.failures.size === 0 };
}
