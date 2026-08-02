// Llama Manager Flasher — app-icon generator.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Scales build/icon-source.png into the platform icon set electron-builder
// consumes: build/icon.png (512px, Linux AppImage), build/icon.ico (Windows),
// and build/icon.icns (macOS). Uses @resvg/resvg-js for high-quality scaling
// and png2icons for the container formats — no network access.
//
// icon-source.png is a 1024px downscale of the Llama Manager `generic`
// app-icon brand slot, vendored into this repo on purpose: the flasher must
// build standalone, so no step here or in the packaging config may reach
// outside it for artwork. Re-vendor that file (and rerun `pnpm gen-icons`)
// when the brand asset set changes. The generated icons are committed so CI
// and fresh clones never need to regenerate them.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import png2icons from 'png2icons';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePng = readFileSync(path.join(root, 'build', 'icon-source.png'));
const sourceDataUrl = `data:image/png;base64,${sourcePng.toString('base64')}`;

/**
 * Rasterizes the icon SVG to a PNG buffer at the given square size.
 *
 * @param {number} size - Output width/height in pixels.
 * @returns {Buffer} PNG-encoded image data.
 */
function renderPng(size) {
  const svg = `
    <svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
      <image href="${sourceDataUrl}" width="1024" height="1024" preserveAspectRatio="xMidYMid meet" />
    </svg>
  `;
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return Buffer.from(resvg.render().asPng());
}

const png512 = renderPng(512);
const png1024 = renderPng(1024);

writeFileSync(path.join(root, 'build', 'icon.png'), png512);

const ico = png2icons.createICO(png1024, png2icons.BICUBIC, 0, false, true);
if (!ico) throw new Error('ICO generation failed');
writeFileSync(path.join(root, 'build', 'icon.ico'), ico);

const icns = png2icons.createICNS(png1024, png2icons.BICUBIC, 0);
if (!icns) throw new Error('ICNS generation failed');
writeFileSync(path.join(root, 'build', 'icon.icns'), icns);

console.log('[gen-icons] wrote build/icon.png, build/icon.ico, build/icon.icns');
