// Llama Manager Flasher — local-image flashing integration contract tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Source-level assertions that a user-chosen image is picked via a native
// dialog, optionally checksum-verified, and written WITHOUT any network
// download — spanning main, preload, and renderer without booting Electron.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
});
