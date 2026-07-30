// Llama Manager Flasher — removable-drive scanner lifecycle boundary.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Normalizes etcher-sdk block-device metadata, applies the shared destructive
// write safety rails, and guarantees that native scanner watchers are stopped
// after every completed or failed enumeration. Keeping lifecycle management in
// this pure module makes repeated UI rescans deterministic and testable.

import { driveRejectionReason, type CandidateDrive } from '../shared/deviceSafety.js';

/** Minimal native scanner contract used by removable-device enumeration. */
export interface ScannerLike {
  /** Current raw drives keyed by the native scanner. */
  drives: Map<unknown, unknown>;
  /** Starts OS device enumeration and hotplug watchers. */
  start: () => Promise<void>;
  /** Stops OS watchers and releases native scanner resources. */
  stop: () => void;
}

/** Drive metadata sent to the renderer's target picker. */
export interface DriveInfo extends CandidateDrive {
  /** Mounted filesystem paths currently associated with the target. */
  mountpoints: string[];
}

/** Native drive fields consumed when normalizing etcher-sdk results. */
interface RawDrive {
  device?: string;
  devicePath?: string;
  description?: string;
  size?: number | null;
  isSystem?: boolean;
  isUSB?: boolean;
  isCard?: boolean;
  isRemovable?: boolean;
  mountpoints?: Array<{ path: string }>;
}

/** Waits briefly for platform block-device services to finish enumeration. */
async function defaultSettle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

/**
 * Enumerates and normalizes removable block devices that pass every safety rail.
 *
 * @param scanner - Started-ready etcher-sdk scanner or a compatible test double.
 * @param settle - Optional platform-enumeration delay used by unit tests.
 * @returns Safe drives suitable for presentation in the target picker.
 * @throws {Error} When the native scanner cannot enumerate block devices.
 */
export async function scanSafeDrives(
  scanner: ScannerLike,
  settle: () => Promise<void> = defaultSettle,
): Promise<DriveInfo[]> {
  await scanner.start();
  try {
    await settle();
    return Array.from(scanner.drives.values() as Iterable<RawDrive>)
      .filter((drive): drive is RawDrive & { device: string } => typeof drive.device === 'string')
      .map((drive): DriveInfo => ({
        device: drive.device,
        description: drive.description ?? drive.devicePath ?? drive.device,
        size: drive.size ?? null,
        isSystem: !!drive.isSystem,
        isUSB: !!drive.isUSB,
        isCard: !!drive.isCard,
        isRemovable: !!drive.isRemovable,
        mountpoints: (drive.mountpoints ?? []).map((mountpoint) => mountpoint.path),
      }))
      .filter((drive) => driveRejectionReason(drive) === null);
  } finally {
    scanner.stop();
  }
}
