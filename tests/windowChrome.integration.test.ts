// Llama Manager Flasher — frameless-window integration contract tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Locks down the security and accessibility wiring that spans Electron's main,
// preload, renderer, and CSS layers. These source-level integration assertions
// complement the command-dispatch behavior tests without booting a graphical
// Electron session in headless CI.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reads one UTF-8 project source file relative to the repository root. */
function source(file: string): string {
  return readFileSync(path.join(root, file), 'utf8');
}

describe('frameless window integration', () => {
  it('routes accessible renderer controls through a narrow owning-window IPC bridge', () => {
    const main = source('src/main/index.ts');
    const preload = source('src/preload/index.cts');
    const app = source('src/renderer/App.tsx');
    const css = source('src/renderer/index.css');

    expect(main).toMatch(/frame:\s*false/);
    expect(main).toContain("ipcMain.handle('window:control'");
    expect(main).toContain('BrowserWindow.fromWebContents(event.sender)');
    expect(preload).toContain("ipcRenderer.invoke('window:control', command)");
    expect(app).toContain('aria-label="Minimize window"');
    expect(app).toContain('aria-label="Toggle maximize window"');
    expect(app).toContain('aria-label="Close window"');
    expect(css).toMatch(/\.titlebar\s*\{[^}]*-webkit-app-region:\s*drag/s);
    expect(css).toMatch(/\.window-controls\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  });
});
