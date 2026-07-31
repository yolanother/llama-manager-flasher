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

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  parseAmdSha256Sums,
  parseSparkRelease,
  type ApplianceImage,
  type PlatformId,
} from '../shared/manifest.js';
import {
  dispatchWindowControl,
  type WindowControl,
} from '../shared/windowControls.js';
import { downloadImage, sha256File, type DownloadProgress } from './download.js';
import { type DriveScanResult } from './driveScanner.js';
import { getElevationStatus } from './elevation.js';
import { HelperClient } from './helperClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the compiled helper entry shipped alongside main. */
const HELPER_SCRIPT = path.join(__dirname, '../helper/index.js');
const helper = new HelperClient();

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
    frame: false,
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

app.on('will-quit', () => helper.dispose());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* ─────────────────────────────────────────────────────────────────
   IPC: custom titlebar window controls
   ─────────────────────────────────────────────────────────────── */

ipcMain.handle('window:control', (event, command: WindowControl) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target) throw new Error('window control has no owning window');
  dispatchWindowControl(command, target);
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

ipcMain.handle('devices:list', async (): Promise<DriveScanResult> => {
  await helper.ensure(process.execPath, HELPER_SCRIPT);
  const result = await helper.request({ type: 'scan' }) as DriveScanResult;
  console.info('[device-scan]', JSON.stringify(result.diagnostics));
  return result;
});

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
   IPC: local image selection (choose from disk + optional verify)
   ─────────────────────────────────────────────────────────────── */

// Opens the native file picker so the user can flash an image they already
// downloaded. Only a user-selected path leaves this handler; flash:start
// already accepts an arbitrary imagePath, so this grants no new privilege.
ipcMain.handle('image:choose', async (): Promise<{ path: string; file: string; size: number | null } | null> => {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a downloaded appliance image',
    properties: ['openFile'],
    filters: [
      { name: 'Disk images', extensions: ['iso', 'img', 'xz'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  const chosen = result.filePaths[0];
  let size: number | null = null;
  try {
    size = (await fs.stat(chosen)).size;
  } catch {
    /* size stays null — the file is still flashable */
  }
  return { path: chosen, file: path.basename(chosen), size };
});

// Optional pre-write checksum for a user-chosen image. Reuses the download
// module's streaming hash and reports a single verifying event so the renderer
// can surface the "Verifying checksum" phase. Throws on mismatch so a bad file
// never reaches the writer.
ipcMain.handle('image:verifyLocal', async (event, args: { path: string; sha256: string }): Promise<string> => {
  const expected = args.sha256.trim().toLowerCase();
  const st = await fs.stat(args.path);
  event.sender.send('image:download:progress', { phase: 'verifying', bytes: st.size, total: st.size });
  const actual = (await sha256File(args.path)).toLowerCase();
  if (actual !== expected) {
    throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
  }
  return args.path;
});

/* ─────────────────────────────────────────────────────────────────
   IPC: flash (write + verify)
   ─────────────────────────────────────────────────────────────── */

ipcMain.handle('flash:start', async (event, args: { devicePath: string; imagePath: string; typedConfirmation: string }) => {
  await helper.ensure(process.execPath, HELPER_SCRIPT);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return helper.request(
    { type: 'flash', devicePath: args.devicePath, imagePath: args.imagePath, typedConfirmation: args.typedConfirmation } as any,
    (p) => event.sender.send('flash:progress', p),
  );
});

/* ─────────────────────────────────────────────────────────────────
   IPC: elevation
   ─────────────────────────────────────────────────────────────── */

ipcMain.handle('elevation:status', () => {
  const status = getElevationStatus();
  return {
    platform: status.platform,
    needsElevation: status.platform === 'win32' || status.platform === 'linux',
    helperReady: helper.isConnected(),
    manualHint: status.manualHint,
  };
});

ipcMain.handle('elevation:ensureHelper', async () => {
  await helper.ensure(process.execPath, HELPER_SCRIPT);
  return { ready: helper.isConnected() };
});

/* ─────────────────────────────────────────────────────────────────
   IPC: app metadata
   ─────────────────────────────────────────────────────────────── */

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
}));
