// Llama Manager Flasher — brand artwork integration tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Pins the renderer titlebar mark, the window backdrop, and the installer icon
// master to the approved Llama Manager `generic` brand asset set — the same set
// the appliance ISO and the marketing site ship — so the three surfaces cannot
// drift apart. Each file is a deterministic downscale of its canonical slot,
// committed so CI and fresh clones never need to regenerate them.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 1024px icon master rasterized by scripts/gen-icons.mjs (from the app-icon slot). */
const ICON_SOURCE_SHA256 = '20d0b298367c72e8f34b5e180974662de869e71b9f92015abb9be8480218349a';
/** 256px titlebar mark bundled into the renderer (from the app-icon slot). */
const BRAND_ICON_SHA256 = '32a0c1d60c7049a471441e6eca04910afee355fab610c6bf2c627de08e737e87';
/** Branded circuit-field backdrop (from the wallpaper slot). */
const APP_BACKDROP_SHA256 = '628e58ae5a8b32808a05d75bd9a17e3d01fa497ebe2a76d08282a6ee85ab3a6d';
/** macOS DMG installer backdrop, recolored to the generic cyan ramp. */
const DMG_BACKDROP_SHA256 = '9d8e228846b50dec28dea4c6dce0f9c179bca0462668e5adf579957a309e4a93';
/** Retina variant of the DMG installer backdrop. */
const DMG_BACKDROP_2X_SHA256 = '5c32a8977020d6b8a26c1212c4c4f220b48c61e3a5781a49ee808f16a190a802';

/** Returns the lowercase SHA-256 checksum of one repository file. */
function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
}

describe('flasher brand artwork', () => {
  it('uses the approved Llama Manager artwork in the titlebar and icon generator', () => {
    expect(sha256('build/icon-source.png')).toBe(ICON_SOURCE_SHA256);
    expect(sha256('src/renderer/brand-icon.png')).toBe(BRAND_ICON_SHA256);

    const app = readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
    const generator = readFileSync(path.join(root, 'scripts/gen-icons.mjs'), 'utf8');
    expect(app).toContain("import brandIcon from './brand-icon.png'");
    expect(generator).toContain("'icon-source.png'");
    expect(generator).not.toContain("'icon.svg'");
  });

  it('uses the branded circuit backdrop rather than a stock scene', () => {
    expect(sha256('src/renderer/app-bg.webp')).toBe(APP_BACKDROP_SHA256);
    expect(readFileSync(path.join(root, 'src/renderer/index.css'), 'utf8'))
      .toContain('url(./app-bg.webp)');
  });

  it('ships the DMG installer backdrop in the generic accent, not the old ember art', () => {
    expect(sha256('build/dmg-background.png')).toBe(DMG_BACKDROP_SHA256);
    expect(sha256('build/dmg-background@2x.png')).toBe(DMG_BACKDROP_2X_SHA256);
  });
});
