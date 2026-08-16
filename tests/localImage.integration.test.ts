// Llama Manager Flasher — local-image flashing integration contract tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Source-level assertions that a user-chosen image is picked via a native
// dialog, optionally checksum-verified, and written WITHOUT any network
// download — spanning main, preload, and renderer without booting Electron —
// plus a real on-disk exercise of the incremental hash-progress reporting the
// interactive pre-write checksum check streams to the renderer.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../src/main/download';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reads one UTF-8 project source file relative to the repository root. */
function source(file: string): string {
  return readFileSync(path.join(root, file), 'utf8');
}

describe('local image flashing integration', () => {
  it('picks and verifies a user-chosen image through a narrow IPC bridge', () => {
    const main = source('src/main/index.ts');
    const preload = source('src/preload/index.cts');
    const app = source('src/renderer/App.tsx');

    // Main process: native file dialog + reused checksum verification.
    expect(main).toContain("ipcMain.handle('image:choose'");
    expect(main).toContain("ipcMain.handle('image:verifyLocal'");
    expect(main).toContain('showOpenDialog');
    expect(main).toContain('sha256File');

    // Preload bridge exposes exactly the two new calls.
    expect(preload).toContain("ipcRenderer.invoke('image:choose')");
    expect(preload).toContain("ipcRenderer.invoke('image:verifyLocal'");

    // Renderer branches a local image off the download path.
    expect(app).toContain('image.verifyLocal');
    expect(app).toContain('isLocalImage');
  });

  it('keeps the throwing pre-write checksum gate separate from the interactive check', () => {
    const main = source('src/main/index.ts');
    const app = source('src/renderer/App.tsx');

    // The interactive check reports; it never throws and never replaces the gate.
    expect(main).toContain("ipcMain.handle('image:checkLocal'");
    expect(main).toContain('sha256 mismatch: expected');
    // startFlash still calls verifyLocal, which throws on mismatch.
    expect(app).toContain('image.verifyLocal');
  });
});

describe('sha256File progress', () => {
  it('reports real cumulative byte counts and still returns the correct digest', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sha-progress-'));
    const file = path.join(dir, 'blob.bin');
    // Two read-stream chunks' worth (default highWaterMark is 64 KiB).
    writeFileSync(file, Buffer.alloc(200 * 1024, 7));

    try {
      const seen: number[] = [];
      const digest = await sha256File(file, (bytes) => seen.push(bytes));

      expect(digest).toBe(await sha256File(file));
      expect(seen.length).toBeGreaterThan(1);
      expect(seen[seen.length - 1]).toBe(200 * 1024);
      // Monotonically increasing — a cumulative total, not per-chunk sizes.
      expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
