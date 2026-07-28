// Llama Manager Flasher — flash-target safety rails.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Pure predicate logic deciding whether a block device may be offered — and,
// independently re-checked in the MAIN process immediately before writing —
// as a flash target. A drive is only eligible when it is not a system drive,
// reports a size, is at most 2 TiB, and is positively identified as
// removable, USB, or a card reader. These rails exist so that a renderer bug
// (or compromised renderer) can never point the writer at an internal disk.
// Pure module (no Electron / etcher-sdk imports) so it is unit-testable.

/**
 * Maximum size in bytes a flash target may report. Anything larger than
 * 2 TiB is almost certainly a fixed disk, not a USB stick / microSD card.
 */
export const MAX_TARGET_BYTES = 2 * 1024 ** 4;

/**
 * The subset of etcher-sdk drive metadata the safety rails evaluate.
 *
 * @property device - OS device path (e.g. /dev/sdb, \\.\PhysicalDrive2).
 * @property description - Human-readable drive description.
 * @property size - Reported size in bytes, or null when unknown.
 * @property isSystem - True when the OS marks the drive as a system disk.
 * @property isUSB - True when attached via USB.
 * @property isCard - True when the drive is an SD/MMC card reader target.
 * @property isRemovable - True when the OS flags the media as removable.
 */
export interface CandidateDrive {
  device: string;
  description: string;
  size: number | null;
  isSystem: boolean;
  isUSB: boolean;
  isCard: boolean;
  isRemovable: boolean;
}

/**
 * Evaluates the safety rails for a candidate flash target.
 *
 * @param drive - Drive metadata as reported by the device scanner.
 * @returns null when the drive is an acceptable target, otherwise a
 *   human-readable reason describing why it was rejected.
 */
export function driveRejectionReason(drive: CandidateDrive): string | null {
  if (drive.isSystem) {
    return 'system drive — refusing to offer it as a flash target';
  }
  if (drive.size == null) {
    return 'drive does not report a size — refusing to flash blind';
  }
  if (drive.size > MAX_TARGET_BYTES) {
    return 'larger than 2 TiB — almost certainly not a USB stick or SD card';
  }
  if (!drive.isRemovable && !drive.isUSB && !drive.isCard) {
    return 'not identified as removable, USB, or a card — refusing fixed disks';
  }
  return null;
}

/**
 * Convenience wrapper over {@link driveRejectionReason}.
 *
 * @param drive - Drive metadata as reported by the device scanner.
 * @returns True when the drive passes every safety rail.
 */
export function isSafeTarget(drive: CandidateDrive): boolean {
  return driveRejectionReason(drive) === null;
}
