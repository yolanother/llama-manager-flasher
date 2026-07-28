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

/** Download progress event forwarded from the main process. */
interface DownloadProgress {
  phase: 'cached' | 'downloading' | 'verifying' | 'retrying';
  bytes: number;
  total: number;
  attempt?: number;
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
  elevated: boolean;
  platform: string;
  canRelaunch: boolean;
  manualHint: string | null;
}

/** The narrow IPC surface the preload bridge exposes to the renderer. */
interface LlamaFlasherBridge {
  manifest: {
    fetch(args: { platformId: 'amd' | 'nvidia-spark' }): Promise<ApplianceImage>;
  };
  devices: {
    list(): Promise<DriveInfo[]>;
  };
  image: {
    download(args: { url: string; file: string; sha256: string; size: number | null }): Promise<string>;
    onProgress(cb: (p: DownloadProgress) => void): () => void;
  };
  flash: {
    start(args: { devicePath: string; imagePath: string; typedConfirmation: string }): Promise<{ ok: boolean }>;
    onProgress(cb: (p: FlashProgress) => void): () => void;
  };
  elevation: {
    status(): Promise<ElevationStatus>;
    relaunch(): Promise<{ relaunching: boolean }>;
  };
  appInfo(): Promise<{ version: string; platform: string }>;
}

interface Window {
  llamaFlasher: LlamaFlasherBridge;
}
