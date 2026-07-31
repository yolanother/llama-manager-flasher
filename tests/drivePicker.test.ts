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
      diagnostics: null,
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
      diagnostics: null,
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
      diagnostics: null,
      onRescan: vi.fn(),
    }));

    expect(html).toContain('Scanning for USB and microSD drives');
    expect(html).toContain('disabled');
  });


  it('distinguishes detected-but-rejected devices from no devices', () => {
    const html = renderToStaticMarkup(createElement(DriveScanNotice, {
      scanning: false,
      error: '',
      diagnostics: {
        rawCandidateCount: 1,
        normalizedCandidateCount: 1,
        acceptedCandidateCount: 0,
        elevated: false,
        readyMs: 24,
        rejections: [{
          ...drive,
          reason: 'larger than 2 TiB — almost certainly not a USB stick or SD card',
        }],
      },
      onRescan: vi.fn(),
    }));

    expect(html).toContain('Devices detected, but none are safe flash targets');
    expect(html).toContain('larger than 2 TiB');
    expect(html).not.toContain('No removable drives found');
  });
});

describe('DrivePermissionNotice', () => {
  it('offers to grant administrator access when the helper is not ready', () => {
    const html = renderToStaticMarkup(createElement(DrivePermissionNotice, {
      elevation: { platform: 'win32', needsElevation: true, helperReady: false, manualHint: null },
      onGrant: vi.fn(),
    }));
    expect(html).toContain('Administrator access is required');
    expect(html).toContain('Grant administrator access');
  });

  it('stays hidden once the helper is connected', () => {
    const html = renderToStaticMarkup(createElement(DrivePermissionNotice, {
      elevation: { platform: 'win32', needsElevation: true, helperReady: true, manualHint: null },
      onGrant: vi.fn(),
    }));
    expect(html).toBe('');
  });

  it('stays hidden on macOS where no up-front elevation is needed', () => {
    const html = renderToStaticMarkup(createElement(DrivePermissionNotice, {
      elevation: { platform: 'darwin', needsElevation: false, helperReady: false, manualHint: null },
      onGrant: vi.fn(),
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
