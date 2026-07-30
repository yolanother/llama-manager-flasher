// Llama Manager Flasher — approved favicon artwork integration tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Ensures both the renderer titlebar and platform installer icon pipeline use
// the exact Llama Manager favicon artwork selected from ui/public/favicon,
// replacing the former hand-drawn flasher badge while keeping generated
// Windows, macOS, and Linux containers reproducible.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_FAVICON_SHA256 = '7290fd8c9f306a00539f55d691f2c670db7bfdccfada19b441a56c0c714adb05';

/** Returns the lowercase SHA-256 checksum of one repository file. */
function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
}

describe('flasher brand artwork', () => {
  it('uses the approved favicon unchanged in the titlebar and icon generator', () => {
    expect(sha256('build/icon-source.png')).toBe(APPROVED_FAVICON_SHA256);
    expect(sha256('src/renderer/brand-icon.png')).toBe(APPROVED_FAVICON_SHA256);

    const app = readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
    const generator = readFileSync(path.join(root, 'scripts/gen-icons.mjs'), 'utf8');
    expect(app).toContain("import brandIcon from './brand-icon.png'");
    expect(generator).toContain("'icon-source.png'");
    expect(generator).not.toContain("'icon.svg'");
  });
});
