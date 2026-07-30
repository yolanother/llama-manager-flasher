// Llama Manager Flasher — drive-picker rescan presentation tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Verifies that removable-media discovery has an explicit, accessible rescan
// action and distinguishes an empty scan from an enumeration failure. These
// states keep Windows permission failures from being misreported as "no drives."

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DrivePermissionNotice,
  DriveScanNotice,
  reconcileSelectedDrive,
} from '../src/renderer/App';

const drive: DriveInfo = {
  device: '\\\\.\\PhysicalDrive2',
  description: 'USB SD Reader',
  size: 64_000_000_000,
  isSystem: false,
  isUSB: true,
  isCard: true,
  isRemovable: true,
  mountpoints: ['E:\\'],
};

describe('DriveScanNotice', () => {
  it('offers a rescan action when no removable media is present', () => {
    const html = renderToStaticMarkup(createElement(DriveScanNotice, {
      scanning: false,
      error: '',
      onRescan: vi.fn(),
    }));

    expect(html).toContain('No removable drives found');
    expect(html).toContain('Insert a USB stick or microSD card');
    expect(html).toContain('Rescan');
  });

  it('reports enumeration errors instead of claiming the drive list is empty', () => {
    const html = renderToStaticMarkup(createElement(DriveScanNotice, {
      scanning: false,
      error: 'Access denied',
      onRescan: vi.fn(),
    }));

    expect(html).toContain('Could not scan removable drives');
    expect(html).toContain('Access denied');
    expect(html).toContain('Try again');
    expect(html).not.toContain('No removable drives found');
  });

  it('announces an active rescan and disables duplicate requests', () => {
    const html = renderToStaticMarkup(createElement(DriveScanNotice, {
      scanning: true,
      error: '',
      onRescan: vi.fn(),
    }));

    expect(html).toContain('Scanning for USB and microSD drives');
    expect(html).toContain('disabled');
  });
});

describe('DrivePermissionNotice', () => {
  it('offers an administrator relaunch before Windows raw-drive access', () => {
    const html = renderToStaticMarkup(createElement(DrivePermissionNotice, {
      elevation: {
        elevated: false,
        platform: 'win32',
        canRelaunch: true,
        manualHint: null,
      },
      onRelaunch: vi.fn(),
    }));

    expect(html).toContain('Administrator access is required');
    expect(html).toContain('Relaunch as administrator');
  });

  it('stays hidden when Windows drive access is already elevated', () => {
    const html = renderToStaticMarkup(createElement(DrivePermissionNotice, {
      elevation: {
        elevated: true,
        platform: 'win32',
        canRelaunch: false,
        manualHint: null,
      },
      onRelaunch: vi.fn(),
    }));

    expect(html).toBe('');
  });
});

describe('reconcileSelectedDrive', () => {
  it('keeps the selection using fresh scanner metadata', () => {
    const refreshed = { ...drive, description: 'USB SD Reader (refreshed)' };
    expect(reconcileSelectedDrive(drive, [refreshed])).toEqual(refreshed);
  });

  it('clears a selection that was unplugged', () => {
    expect(reconcileSelectedDrive(drive, [])).toBeNull();
  });
});
