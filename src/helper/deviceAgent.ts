// Llama Manager Flasher — privileged device agent (scan + flash via etcher-sdk).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Runs ONLY inside the elevated helper process. Owns the sole import of
// etcher-sdk and re-checks every safety rail (removable-only, size cap,
// re-enumerate-and-match) at the privileged boundary before any raw write.

import { driveRejectionReason } from '../shared/deviceSafety.js';
import {
  normalizeDriveCandidate,
  scanSafeDrives,
  waitForScannerReady,
  type DriveScanResult,
  type ScannerLike,
} from '../main/driveScanner.js';
import { getElevationStatus } from '../main/elevation.js';
import type { HelperFlashProgress } from '../shared/helperProtocol.js';

/** Lazily constructs an etcher-sdk Scanner over non-system block devices. */
async function loadScanner() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (await import('etcher-sdk')) as any;
  const adapters = [
    new sdk.scanner.adapters.BlockDeviceAdapter({ includeSystemDrives: () => false }),
  ];
  return new sdk.scanner.Scanner(adapters);
}

/** Enumerates safe removable block devices with diagnostics. */
export async function scanDevices(): Promise<DriveScanResult> {
  const scanner = (await loadScanner()) as ScannerLike;
  return scanSafeDrives(scanner, { elevated: getElevationStatus().elevated });
}

/** Writes and verifies an image to a re-enumerated, safety-checked device. */
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

  const scanner = await loadScanner();
  await waitForScannerReady(scanner as ScannerLike);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target = Array.from(scanner.drives.values() as Iterable<any>)
    .find((d) => d.device === args.devicePath);
  if (!target) {
    scanner.stop();
    throw new Error(`device ${args.devicePath} not found — was it unplugged?`);
  }

  const normalizedTarget = normalizeDriveCandidate(target);
  const rejection = normalizedTarget == null
    ? 'missing device path — cannot safely identify the target'
    : driveRejectionReason(normalizedTarget);
  if (rejection) {
    scanner.stop();
    throw new Error(`refusing to flash ${args.devicePath}: ${rejection}`);
  }

  const writer = new sourceDestination.BlockDevice({
    drive: target, unmountOnSuccess: true, write: true, direct: true,
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
  scanner.stop();
  return { ok: result.failures.size === 0 };
}
