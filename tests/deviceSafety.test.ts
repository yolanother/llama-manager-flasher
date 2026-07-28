// Llama Manager Flasher — unit tests for the flash-target safety rails.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Verifies the device-filter safety logic that both the drive picker and the
// pre-write re-check in the main process rely on: system drives, sizeless
// drives, >2 TiB drives, and fixed (non-removable/USB/card) disks are all
// rejected, while ordinary sticks and cards pass.

import { describe, it, expect } from 'vitest';
import {
  driveRejectionReason,
  isSafeTarget,
  MAX_TARGET_BYTES,
  type CandidateDrive,
} from '../src/shared/deviceSafety';

/** Builds a safe baseline USB-stick candidate, overridable per test. */
function drive(overrides: Partial<CandidateDrive> = {}): CandidateDrive {
  return {
    device: '/dev/sdb',
    description: 'SanDisk Ultra USB 3.0',
    size: 64_000_000_000,
    isSystem: false,
    isUSB: true,
    isCard: false,
    isRemovable: true,
    ...overrides,
  };
}

describe('driveRejectionReason', () => {
  it('accepts an ordinary removable USB stick', () => {
    expect(driveRejectionReason(drive())).toBeNull();
    expect(isSafeTarget(drive())).toBe(true);
  });

  it('accepts a card-reader target that is not flagged removable', () => {
    expect(
      driveRejectionReason(drive({ isUSB: false, isRemovable: false, isCard: true })),
    ).toBeNull();
  });

  it('accepts a removable drive that is neither USB nor card', () => {
    expect(
      driveRejectionReason(drive({ isUSB: false, isCard: false, isRemovable: true })),
    ).toBeNull();
  });

  it('rejects system drives even when flagged removable', () => {
    expect(driveRejectionReason(drive({ isSystem: true }))).toMatch(/system drive/);
  });

  it('rejects drives that do not report a size', () => {
    expect(driveRejectionReason(drive({ size: null }))).toMatch(/size/);
  });

  it('rejects drives larger than 2 TiB', () => {
    expect(driveRejectionReason(drive({ size: MAX_TARGET_BYTES + 1 }))).toMatch(/2 TiB/);
  });

  it('accepts a drive exactly at the 2 TiB cap', () => {
    expect(driveRejectionReason(drive({ size: MAX_TARGET_BYTES }))).toBeNull();
  });

  it('rejects fixed disks (not removable, not USB, not card)', () => {
    expect(
      driveRejectionReason(drive({ isUSB: false, isCard: false, isRemovable: false })),
    ).toMatch(/fixed disks/);
  });
});
