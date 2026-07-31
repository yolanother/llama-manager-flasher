// Llama Manager Flasher — removable-drive scanner lifecycle tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.

import { describe, expect, it, vi } from 'vitest';
import {
  normalizeDriveCandidate,
  scanSafeDrives,
  waitForScannerReady,
  type ScannerLike,
} from '../src/main/driveScanner';

/** Creates a deterministic scanner double for lifecycle assertions. */
function scannerWith(drives: unknown[], start = vi.fn(async () => undefined)): ScannerLike {
  return {
    drives: new Map(drives.map((drive, index) => [String(index), drive])),
    start,
    stop: vi.fn(),
  };
}

const usb = {
  device: '\\\\.\\PhysicalDrive2',
  description: 'USB SD Reader',
  size: 64_000_000_000,
  isSystem: false,
  isUSB: true,
  isCard: true,
  isRemovable: true,
  mountpoints: [{ path: 'E:\\' }],
};

describe('normalizeDriveCandidate', () => {
  it('uses the backing drivelist flags omitted by etcher BlockDevice wrappers', () => {
    const wrapper = {
      device: usb.device,
      description: usb.description,
      size: usb.size,
      isSystem: false,
      mountpoints: usb.mountpoints,
      drive: usb,
    };

    expect(normalizeDriveCandidate(wrapper)).toMatchObject({
      device: usb.device,
      isUSB: true,
      isCard: true,
      isRemovable: true,
    });
  });
});

describe('waitForScannerReady', () => {
  it('bounds a native scanner that never emits first-scan readiness', async () => {
    vi.useFakeTimers();
    const scanner = scannerWith([], vi.fn(() => new Promise<void>(() => undefined)));
    const readiness = waitForScannerReady(scanner, 50);
    const rejection = expect(readiness).rejects.toThrow('did not become ready within 50 ms');
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    vi.useRealTimers();
  });
});

describe('scanSafeDrives', () => {
  it('normalizes safe targets, reports rejected candidates, and always stops', async () => {
    const scanner = scannerWith([{
      device: usb.device,
      description: usb.description,
      size: usb.size,
      isSystem: false,
      mountpoints: usb.mountpoints,
      drive: usb,
    }, {
      device: '\\\\.\\PhysicalDrive1',
      description: 'Large external disk',
      size: 4_000_000_000_000,
      isSystem: false,
      isUSB: false,
      isCard: false,
      isRemovable: true,
      mountpoints: [{ path: 'D:\\' }],
    }]);

    const result = await scanSafeDrives(scanner, { elevated: false });
    expect(result.drives).toEqual([{
      ...usb,
      mountpoints: ['E:\\'],
    }]);
    expect(result.diagnostics).toMatchObject({
      rawCandidateCount: 2,
      normalizedCandidateCount: 2,
      acceptedCandidateCount: 1,
      elevated: false,
      rejections: [{
        device: '\\\\.\\PhysicalDrive1',
        reason: expect.stringContaining('larger than 2 TiB'),
      }],
    });
    expect(result.diagnostics.readyMs).toBeGreaterThanOrEqual(0);
    expect(scanner.start).toHaveBeenCalledOnce();
    expect(scanner.stop).toHaveBeenCalledOnce();
  });

  it('diagnoses candidates without a device identity instead of silently dropping them', async () => {
    const scanner = scannerWith([{
      description: 'Incomplete reader',
      size: 32_000_000_000,
      isRemovable: true,
    }]);

    const result = await scanSafeDrives(scanner, { elevated: true });
    expect(result.drives).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      rawCandidateCount: 1,
      normalizedCandidateCount: 0,
      acceptedCandidateCount: 0,
      elevated: true,
      rejections: [{ reason: expect.stringContaining('missing device path') }],
    });
  });

  it('stops the native scanner when enumeration startup fails', async () => {
    const failure = new Error('Access denied while reading physical drives');
    const scanner = scannerWith([], vi.fn(async () => { throw failure; }));

    await expect(scanSafeDrives(scanner)).rejects.toThrow(failure);
    expect(scanner.stop).toHaveBeenCalledOnce();
  });
});
