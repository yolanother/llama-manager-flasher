// Llama Manager Flasher — removable-drive scanner lifecycle tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Exercises the native-scanner boundary with a fake adapter so repeated manual
// rescans cannot leak a watcher after success or an enumeration failure.

import { describe, expect, it, vi } from 'vitest';
import { scanSafeDrives, type ScannerLike } from '../src/main/driveScanner';

/** Creates a deterministic scanner double for lifecycle assertions. */
function scannerWith(drives: unknown[]): ScannerLike {
  return {
    drives: new Map(drives.map((drive, index) => [String(index), drive])),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
}

describe('scanSafeDrives', () => {
  it('normalizes safe targets and always stops the scanner', async () => {
    const scanner = scannerWith([{
      device: '\\\\.\\PhysicalDrive2',
      description: 'USB SD Reader',
      size: 64_000_000_000,
      isSystem: false,
      isUSB: true,
      isCard: true,
      isRemovable: true,
      mountpoints: [{ path: 'E:\\' }],
    }, {
      device: '\\\\.\\PhysicalDrive0',
      description: 'System disk',
      size: 1_000_000_000_000,
      isSystem: true,
      isUSB: false,
      isCard: false,
      isRemovable: false,
      mountpoints: [{ path: 'C:\\' }],
    }]);

    await expect(scanSafeDrives(scanner, async () => undefined)).resolves.toEqual([{
      device: '\\\\.\\PhysicalDrive2',
      description: 'USB SD Reader',
      size: 64_000_000_000,
      isSystem: false,
      isUSB: true,
      isCard: true,
      isRemovable: true,
      mountpoints: ['E:\\'],
    }]);
    expect(scanner.start).toHaveBeenCalledOnce();
    expect(scanner.stop).toHaveBeenCalledOnce();
  });

  it('stops the native scanner when enumeration fails after startup', async () => {
    const scanner = scannerWith([]);
    const failure = new Error('Access denied while reading physical drives');

    await expect(scanSafeDrives(scanner, async () => { throw failure; })).rejects.toThrow(failure);
    expect(scanner.stop).toHaveBeenCalledOnce();
  });
});
