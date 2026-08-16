// Llama Manager Flasher — renderer-side typings for the preload bridge.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Declares the `window.llamaFlasher` global the preload script exposes via
// contextBridge, so the renderer gets full type safety over the IPC surface
// without importing any main-process code.

/** Normalized appliance image descriptor (mirror of src/shared/manifest.ts). */
interface ApplianceImage {
  platformId: 'amd' | 'nvidia-spark';
  arch: string;
  channel: 'stable' | 'experimental';
  version: string;
  file: string;
  url: string;
  sha256: string;
  size: number | null;
}

/** A user-chosen image file on disk, flashed instead of downloading one. */
interface LocalImage {
  kind: 'local';
  file: string;
  size: number | null;
  path: string;
  /** Expected lowercase-hex SHA-256 to verify before writing, '' when none. */
  sha256: string;
}

/** Result of the native "choose a downloaded image" file dialog. */
interface LocalImageSelection {
  path: string;
  file: string;
  size: number | null;
}

/** Drive metadata as offered by the main-process target scanner. */
interface DriveInfo {
  device: string;
  description: string;
  size: number | null;
  isSystem: boolean;
  isUSB: boolean;
  isCard: boolean;
  isRemovable: boolean;
  mountpoints: string[];
}
interface DriveScanDiagnostics {
  rawCandidateCount: number;
  normalizedCandidateCount: number;
  acceptedCandidateCount: number;
  elevated: boolean;
  readyMs: number;
  rejections: Array<DriveInfo & { reason: string }>;
}

interface DriveScanResult {
  drives: DriveInfo[];
  diagnostics: DriveScanDiagnostics;
}


/** Download progress event forwarded from the main process. */
interface DownloadProgress {
  phase: 'cached' | 'downloading' | 'verifying' | 'retrying';
  bytes: number;
  total: number;
  attempt?: number;
}

/**
 * Outcome of the interactive, non-throwing local-image checksum pre-check.
 *
 * `ok` is only meaningful when `error` is null: an unreadable file reports
 * `ok: false` with a message, which the UI must NOT present as a mismatch.
 */
interface LocalImageCheck {
  /** True when the file's digest equals the expected one. */
  ok: boolean;
  /** The file's actual lowercase-hex digest, or '' when it could not be read. */
  actual: string;
  /** Read/IO failure message, or null when the file was hashed successfully. */
  error: string | null;
}

/** Hash progress for one interactive pre-check, tagged with its request token. */
interface LocalImageCheckProgress {
  /** Token of the check this event belongs to; stale tokens must be ignored. */
  token: number;
  bytes: number;
  total: number;
}

/** Flash progress event forwarded from the main process. */
interface FlashProgress {
  phase: string;
  bytesWritten?: number;
  size?: number;
  speed?: number;
  percentage?: number;
  error?: string;
}

/** Elevation status of the main process. */
interface ElevationStatus {
  platform: string;
  needsElevation: boolean;
  helperReady: boolean;
  manualHint: string | null;
}

/** Native operation available to the custom renderer titlebar. */
type WindowControl = 'minimize' | 'maximize' | 'close';

/** The narrow IPC surface the preload bridge exposes to the renderer. */
interface LlamaFlasherBridge {
  window: {
    control(command: WindowControl): Promise<void>;
  };
  manifest: {
    fetch(args: { platformId: 'amd' | 'nvidia-spark' }): Promise<ApplianceImage>;
  };
  devices: {
    list(): Promise<DriveScanResult>;
  };
  image: {
    download(args: { url: string; file: string; sha256: string; size: number | null }): Promise<string>;
    choose(): Promise<LocalImageSelection | null>;
    verifyLocal(args: { path: string; sha256: string }): Promise<string>;
    checkLocal(args: { path: string; sha256: string; token: number }): Promise<LocalImageCheck>;
    onCheckProgress(cb: (p: LocalImageCheckProgress) => void): () => void;
    onProgress(cb: (p: DownloadProgress) => void): () => void;
  };
  flash: {
    start(args: { devicePath: string; imagePath: string; typedConfirmation: string }): Promise<{ ok: boolean }>;
    onProgress(cb: (p: FlashProgress) => void): () => void;
  };
  elevation: {
    status(): Promise<ElevationStatus>;
    ensureHelper(): Promise<{ ready: boolean }>;
  };
  appInfo(): Promise<{ version: string; platform: string }>;
}

interface Window {
  llamaFlasher: LlamaFlasherBridge;
}
