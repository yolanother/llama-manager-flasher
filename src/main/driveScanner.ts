// Llama Manager Flasher — removable-drive scanner lifecycle boundary.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Normalizes etcher-sdk block-device metadata, applies the shared destructive
// write safety rails, and guarantees that native scanner watchers are stopped
// after every completed or failed enumeration.

import { driveRejectionReason, type CandidateDrive } from '../shared/deviceSafety.js';

/** Scanner startup includes the first OS scan; warm Windows scans took 10–26 ms. */
// Allow cold native-module initialization observed above two seconds, but never wait unbounded.
export const SCANNER_READY_TIMEOUT_MS = 10_000;

export interface ScannerLike {
  /** Map and Set both expose values(). */
  drives: { values: () => IterableIterator<unknown> };
  /** Resolves after every adapter emits ready following its first enumeration. */
  start: () => Promise<void>;
  stop: () => void;
  once?: (event: 'error', listener: (error: Error) => void) => void;
  off?: (event: 'error', listener: (error: Error) => void) => void;
}

export interface DriveInfo extends CandidateDrive {
  mountpoints: string[];
}

export interface DriveRejectionDiagnostic extends CandidateDrive {
  reason: string;
}

export interface DriveScanDiagnostics {
  rawCandidateCount: number;
  normalizedCandidateCount: number;
  acceptedCandidateCount: number;
  elevated: boolean;
  readyMs: number;
  rejections: DriveRejectionDiagnostic[];
}

export interface DriveScanResult {
  drives: DriveInfo[];
  diagnostics: DriveScanDiagnostics;
}

interface RawDrive {
  drive?: unknown;
  device?: string;
  devicePath?: string | null;
  description?: string;
  size?: number | null;
  isSystem?: boolean;
  isUSB?: boolean;
  isCard?: boolean;
  isRemovable?: boolean;
  mountpoints?: Array<{ path?: string }>;
}

function isRawDrive(value: unknown): value is RawDrive {
  return typeof value === 'object' && value !== null;
}

/**
 * Scanner.drives contains BlockDevice wrappers whose public getters omit the
 * eligibility flags. The backing drivelist record retains those observed flags.
 */
function backingDrive(candidate: unknown): RawDrive {
  if (!isRawDrive(candidate)) return {};
  return isRawDrive(candidate.drive) ? candidate.drive : candidate;
}

/** Normalizes either a drivelist record or etcher-sdk BlockDevice wrapper. */
export function normalizeDriveCandidate(candidate: unknown): DriveInfo | null {
  const wrapper = isRawDrive(candidate) ? candidate : {};
  const raw = backingDrive(candidate);
  const device = raw.device ?? wrapper.device;
  if (typeof device !== 'string' || device.length === 0) return null;

  const mountpoints = raw.mountpoints ?? wrapper.mountpoints ?? [];
  return {
    device,
    description: raw.description ?? wrapper.description ?? raw.devicePath ?? wrapper.devicePath ?? device,
    size: raw.size ?? wrapper.size ?? null,
    isSystem: !!(raw.isSystem ?? wrapper.isSystem),
    isUSB: !!(raw.isUSB ?? wrapper.isUSB),
    isCard: !!(raw.isCard ?? wrapper.isCard),
    isRemovable: !!(raw.isRemovable ?? wrapper.isRemovable),
    mountpoints: mountpoints.flatMap((mountpoint) =>
      typeof mountpoint.path === 'string' ? [mountpoint.path] : []),
  };
}

/** Waits on etcher's first-enumeration readiness promise, with a hard bound. */
export async function waitForScannerReady(
  scanner: ScannerLike,
  timeoutMs = SCANNER_READY_TIMEOUT_MS,
): Promise<number> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onError: ((error: Error) => void) | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (callback: () => void) => {
        if (timer) clearTimeout(timer);
        if (onError && scanner.off) scanner.off('error', onError);
        callback();
      };
      onError = (error) => finish(() => reject(error));
      scanner.once?.('error', onError);
      timer = setTimeout(
        () => finish(() => reject(new Error(`device scanner did not become ready within ${timeoutMs} ms`))),
        timeoutMs,
      );
      scanner.start().then(
        () => finish(resolve),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onError && scanner.off) scanner.off('error', onError);
  }

  return Date.now() - startedAt;
}

function diagnostic(drive: DriveInfo, reason: string): DriveRejectionDiagnostic {
  const { mountpoints: _mountpoints, ...safeFields } = drive;
  return { ...safeFields, reason };
}

/**
 * Normalizes, safety-filters, and diagnoses a set of raw scanner candidates.
 * Pure: does not start or stop the scanner, so a long-lived scanner can be
 * read repeatedly without the churn of per-scan start/stop cycles.
 *
 * @param candidates - The scanner's current drive objects.
 * @param options - Elevation flag and the measured readiness time.
 * @returns Accepted removable drives plus sanitized diagnostics.
 */
export function buildScanResult(
  candidates: unknown[],
  options: { elevated?: boolean; readyMs: number },
): DriveScanResult {
  const normalized = candidates.map(normalizeDriveCandidate);
  const drives: DriveInfo[] = [];
  const rejections: DriveRejectionDiagnostic[] = [];

  normalized.forEach((drive, index) => {
    if (drive == null) {
      const raw = backingDrive(candidates[index]);
      rejections.push({
        device: '(missing)',
        description: raw.description ?? raw.devicePath ?? 'Unnamed block device',
        size: raw.size ?? null,
        isSystem: !!raw.isSystem,
        isUSB: !!raw.isUSB,
        isCard: !!raw.isCard,
        isRemovable: !!raw.isRemovable,
        reason: 'missing device path — cannot safely identify the target',
      });
      return;
    }
    const reason = driveRejectionReason(drive);
    if (reason) rejections.push(diagnostic(drive, reason));
    else drives.push(drive);
  });

  return {
    drives,
    diagnostics: {
      rawCandidateCount: candidates.length,
      normalizedCandidateCount: normalized.filter((drive) => drive !== null).length,
      acceptedCandidateCount: drives.length,
      elevated: !!options.elevated,
      readyMs: options.readyMs,
      rejections,
    },
  };
}

/**
 * Enumerates safe removable block devices. Scanner.start() resolves after the
 * adapter's first drivelist scan, so no post-ready sleep is necessary. Starts
 * and stops the scanner around a single enumeration; for repeated scans prefer
 * a long-lived scanner with {@link buildScanResult}.
 */
export async function scanSafeDrives(
  scanner: ScannerLike,
  options: { elevated?: boolean; readyTimeoutMs?: number } = {},
): Promise<DriveScanResult> {
  try {
    const readyMs = await waitForScannerReady(scanner, options.readyTimeoutMs);
    return buildScanResult(Array.from(scanner.drives.values()), {
      elevated: options.elevated,
      readyMs,
    });
  } finally {
    scanner.stop();
  }
}
