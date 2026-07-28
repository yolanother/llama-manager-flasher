// Llama Manager Flasher — preload script (renderer ↔ main IPC bridge).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Runs in an isolated context with Node access and exposes a tightly-scoped
// `llamaFlasher` global to the renderer via contextBridge. The renderer can
// ONLY call these methods — it cannot import etcher-sdk or reach devices /
// the filesystem directly. This is the security boundary that keeps a
// renderer XSS from spawning arbitrary raw-device writes.

const { contextBridge, ipcRenderer } = require('electron');

/** Mirror of the shared ApplianceImage shape (kept dependency-free). */
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

const api = {
  manifest: {
    fetch: (args: { platformId: 'amd' | 'nvidia-spark' }): Promise<ApplianceImage> =>
      ipcRenderer.invoke('manifest:fetch', args),
  },
  devices: {
    list: (): Promise<DriveInfo[]> => ipcRenderer.invoke('devices:list'),
  },
  image: {
    download: (args: { url: string; file: string; sha256: string; size: number | null }): Promise<string> =>
      ipcRenderer.invoke('image:download', args),
    onProgress: (cb: (p: DownloadProgress) => void) => {
      const handler = (_e: unknown, p: DownloadProgress) => cb(p);
      ipcRenderer.on('image:download:progress', handler);
      return () => ipcRenderer.off('image:download:progress', handler);
    },
  },
  flash: {
    start: (args: { devicePath: string; imagePath: string; typedConfirmation: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('flash:start', args),
    onProgress: (cb: (p: FlashProgress) => void) => {
      const handler = (_e: unknown, p: FlashProgress) => cb(p);
      ipcRenderer.on('flash:progress', handler);
      return () => ipcRenderer.off('flash:progress', handler);
    },
  },
  elevation: {
    status: (): Promise<ElevationStatus> => ipcRenderer.invoke('elevation:status'),
    relaunch: (): Promise<{ relaunching: boolean }> => ipcRenderer.invoke('elevation:relaunch'),
  },
  appInfo: (): Promise<{ version: string; platform: string }> => ipcRenderer.invoke('app:info'),
};

contextBridge.exposeInMainWorld('llamaFlasher', api);

export type LlamaFlasherAPI = typeof api;
