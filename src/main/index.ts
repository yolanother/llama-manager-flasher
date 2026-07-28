// Llama Manager Flasher — Electron main process.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Owns the privileged side of the flasher: fetching and normalizing the
// appliance release manifests, enumerating candidate USB / microSD targets,
// downloading the ISO with resume + SHA-256 verification, and writing it to
// the chosen device via etcher-sdk with post-write verification. The renderer
// never touches devices or the network directly — it talks to this process
// through the narrow IPC surface defined in preload/index.cts. Every safety
// rail (removable-only, 2 TiB cap, re-enumerate-and-match, typed destructive
// confirmation) is enforced HERE, so a renderer bug can never write to an
// internal disk. This is a portable one-shot tool: there is deliberately no
// auto-updater.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseAmdSha256Sums,
  parseSparkRelease,
  type ApplianceImage,
  type PlatformId,
} from '../shared/manifest.js';
import { driveRejectionReason, type CandidateDrive } from '../shared/deviceSafety.js';
import { downloadImage, type DownloadProgress } from './download.js';
import { getElevationStatus, relaunchElevated } from './elevation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Renderer entry: Vite dev server in dev, built index.html in production. */
const RENDERER_URL = process.env.VITE_DEV_SERVER_URL
  ?? `file://${path.join(__dirname, '../renderer/index.html')}`;

/** AMD Ryzen stable channel: SHA256SUMS + ISO live under this base. */
const AMD_BASE_URL = process.env.LMF_AMD_BASE_URL
  ?? 'https://llama-manager.doubtech.ai/downloads';

/** NVIDIA DGX Spark experimental channel: release.json + ISO base. */
const SPARK_BASE_URL = process.env.LMF_SPARK_BASE_URL
  ?? 'https://llama-manager.doubtech.ai/downloads-nvidia-spark';

/** Where verified appliance ISOs are cached between runs. */
const CACHE_DIR = path.join(app.getPath('userData'), 'image-cache');

let mainWindow: BrowserWindow | null = null;

/**
 * Creates the single application window with the preload-bridged renderer.
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 760,
    minHeight: 560,
    title: 'Llama Manager Flasher',
    backgroundColor: '#070708',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    autoHideMenuBar: true,
    show: false,
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadURL(RENDERER_URL);

  // External links open in the user's browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* ─────────────────────────────────────────────────────────────────
   IPC: manifest fetch + normalization
   ─────────────────────────────────────────────────────────────── */

ipcMain.handle('manifest:fetch', async (_event, args: { platformId: PlatformId }): Promise<ApplianceImage> => {
  if (args.platformId === 'amd') {
    const url = `${AMD_BASE_URL}/SHA256SUMS?t=${Date.now()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SHA256SUMS fetch failed: HTTP ${r.status}`);
    const image = parseAmdSha256Sums(await r.text(), AMD_BASE_URL);
    // SHA256SUMS carries no size; resolve it via HEAD so the UI can show a
    // download total. Non-fatal when the server refuses HEAD.
    try {
      const head = await fetch(image.url, { method: 'HEAD' });
      const len = Number(head.headers.get('content-length') ?? 0);
      if (head.ok && len > 0) return { ...image, size: len };
    } catch {
      /* size stays null */
    }
    return image;
  }
  if (args.platformId === 'nvidia-spark') {
    const url = `${SPARK_BASE_URL}/release.json?t=${Date.now()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`release.json fetch failed: HTTP ${r.status}`);
    return parseSparkRelease(await r.json(), SPARK_BASE_URL);
  }
  throw new Error(`unknown platform: ${String(args.platformId)}`);
});

/* ─────────────────────────────────────────────────────────────────
   IPC: device enumeration
   ─────────────────────────────────────────────────────────────── */

/**
 * Lazily constructs an etcher-sdk Scanner over non-system block devices.
 * Lazy so type-only checks and tests never load the native modules.
 *
 * @returns A started-ready Scanner instance.
 */
async function loadScanner() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = await import('etcher-sdk') as any;
  const adapters = [
    new sdk.scanner.adapters.BlockDeviceAdapter({
      includeSystemDrives: () => false,
    }),
  ];
  return new sdk.scanner.Scanner(adapters);
}

/** Drive metadata sent to the renderer's target picker. */
interface DriveInfo extends CandidateDrive {
  mountpoints: string[];
}

/**
 * Enumerates block devices and returns only those passing the safety rails.
 * The 250ms settle delay compensates for macOS DiskArbitration lag.
 *
 * @returns Drives that are safe to offer as flash targets.
 */
async function scanSafeDrives(): Promise<DriveInfo[]> {
  const scanner = await loadScanner();
  await scanner.start();
  await new Promise((r) => setTimeout(r, 250));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drives = Array.from(scanner.drives.values() as Iterable<any>);
  scanner.stop();
  return drives
    .map((d): DriveInfo => ({
      device: d.device,
      description: d.description ?? d.devicePath ?? d.device,
      size: d.size ?? null,
      isSystem: !!d.isSystem,
      isUSB: !!d.isUSB,
      isCard: !!d.isCard,
      isRemovable: !!d.isRemovable,
      mountpoints: (d.mountpoints ?? []).map((m: { path: string }) => m.path),
    }))
    .filter((d) => driveRejectionReason(d) === null);
}

ipcMain.handle('devices:list', async (): Promise<DriveInfo[]> => scanSafeDrives());

/* ─────────────────────────────────────────────────────────────────
   IPC: image download (resume + retry + sha256 verify)
   ─────────────────────────────────────────────────────────────── */

ipcMain.handle('image:download', async (event, args: { url: string; file: string; sha256: string; size: number | null }): Promise<string> => {
  return downloadImage({
    url: args.url,
    file: args.file,
    sha256: args.sha256,
    size: args.size,
    cacheDir: CACHE_DIR,
    onProgress: (p: DownloadProgress) => event.sender.send('image:download:progress', p),
  });
});

/* ─────────────────────────────────────────────────────────────────
   IPC: flash (write + verify)
   ─────────────────────────────────────────────────────────────── */

ipcMain.handle('flash:start', async (event, args: { devicePath: string; imagePath: string; typedConfirmation: string }) => {
  // Destructive-confirmation rail: the renderer must pass through what the
  // user actually typed, and it must match the target device path.
  if (args.typedConfirmation !== args.devicePath) {
    throw new Error('confirmation text does not match the selected device');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = await import('etcher-sdk') as any;
  const { sourceDestination, multiWrite } = sdk;

  const source: unknown = args.imagePath.endsWith('.xz')
    ? new sourceDestination.XzSource(new sourceDestination.File({ path: args.imagePath }))
    : new sourceDestination.File({ path: args.imagePath });

  // Re-enumerate-and-match: etcher-sdk gets its own freshly scanned drive
  // object, never one constructed from renderer input.
  const scanner = await loadScanner();
  await scanner.start();
  await new Promise((r) => setTimeout(r, 250));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target = Array.from(scanner.drives.values() as Iterable<any>)
    .find((d) => d.device === args.devicePath);
  if (!target) {
    scanner.stop();
    throw new Error(`device ${args.devicePath} not found — was it unplugged?`);
  }

  // Safety rails re-checked in the main process at the last moment.
  const rejection = driveRejectionReason({
    device: target.device,
    description: target.description ?? '',
    size: target.size ?? null,
    isSystem: !!target.isSystem,
    isUSB: !!target.isUSB,
    isCard: !!target.isCard,
    isRemovable: !!target.isRemovable,
  });
  if (rejection) {
    scanner.stop();
    throw new Error(`refusing to flash ${args.devicePath}: ${rejection}`);
  }

  const writer = new sourceDestination.BlockDevice({
    drive: target,
    unmountOnSuccess: true,
    write: true,
    direct: true,
  });

  const result = await multiWrite.pipeSourceToDestinations({
    source,
    destinations: [writer],
    verify: true,
    trim: false,
    onProgress: (p: { type: string; bytesWritten?: number; size?: number; speed?: number; percentage?: number }) => {
      event.sender.send('flash:progress', {
        phase: p.type,
        bytesWritten: p.bytesWritten ?? 0,
        size: p.size ?? 0,
        speed: p.speed ?? 0,
        percentage: p.percentage ?? 0,
      });
    },
    onFail: (_dest: unknown, err: Error) => {
      event.sender.send('flash:progress', { phase: 'failed', error: err.message });
    },
  });
  scanner.stop();
  return { ok: result.failures.size === 0 };
});

/* ─────────────────────────────────────────────────────────────────
   IPC: elevation
   ─────────────────────────────────────────────────────────────── */

ipcMain.handle('elevation:status', () => getElevationStatus());

ipcMain.handle('elevation:relaunch', () => {
  relaunchElevated(() => app.quit());
  return { relaunching: true };
});

/* ─────────────────────────────────────────────────────────────────
   IPC: app metadata
   ─────────────────────────────────────────────────────────────── */

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
}));
