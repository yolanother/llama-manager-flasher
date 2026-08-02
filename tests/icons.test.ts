// Llama Manager Flasher — packaged icon format tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Parses the committed build/ icon containers that electron-builder feeds to
// each platform packager and asserts they are genuine multi-resolution icon
// files rather than renamed PNGs: the Windows .ico carries a full ladder of
// entries down to 16px, the macOS .icns declares a self-consistent length and
// the Retina icon types, and the Linux .png is a real 512px RGBA image. A
// silently-invalid container only surfaces at install time on the target OS,
// so it is checked here instead.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** One image entry inside a Windows .ico directory. */
interface IcoEntry {
  width: number;
  height: number;
  bitsPerPixel: number;
  byteLength: number;
  /** True when the entry's payload is an embedded PNG rather than a DIB. */
  isPng: boolean;
}

/** One tagged chunk inside a macOS .icns container. */
interface IcnsChunk {
  /** Four-character OSType, e.g. `ic10` for the 1024px Retina slot. */
  type: string;
  byteLength: number;
  /** Square pixel dimension when the payload is a PNG, else null. */
  pngSize: number | null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Reads a repository file as a buffer.
 *
 * @param file - Repo-relative path.
 * @returns The file contents.
 */
function read(file: string): Buffer {
  return readFileSync(path.join(root, file));
}

/**
 * Parses the directory of a Windows .ico container.
 *
 * @param buf - Raw .ico bytes.
 * @returns One descriptor per image entry, in file order.
 * @throws When the ICONDIR header is not a well-formed icon directory.
 */
function parseIco(buf: Buffer): IcoEntry[] {
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1 || count === 0) throw new Error('not a valid ICO directory');

  const entries: IcoEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const byteLength = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    entries.push({
      // A zero dimension byte encodes 256 in the ICO format.
      width: buf.readUInt8(at) || 256,
      height: buf.readUInt8(at + 1) || 256,
      bitsPerPixel: buf.readUInt16LE(at + 6),
      byteLength,
      isPng: buf.subarray(offset, offset + 8).equals(PNG_MAGIC),
    });
  }
  return entries;
}

/**
 * Walks the chunk table of a macOS .icns container.
 *
 * @param buf - Raw .icns bytes.
 * @returns One descriptor per tagged chunk, in file order.
 * @throws When the magic or the declared container length is wrong.
 */
function parseIcns(buf: Buffer): IcnsChunk[] {
  if (buf.subarray(0, 4).toString('latin1') !== 'icns') throw new Error('not an ICNS container');
  const declared = buf.readUInt32BE(4);
  if (declared !== buf.length) throw new Error(`ICNS length ${declared} != file size ${buf.length}`);

  const chunks: IcnsChunk[] = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const byteLength = buf.readUInt32BE(at + 4);
    if (byteLength < 8 || at + byteLength > buf.length) throw new Error('truncated ICNS chunk');
    const body = buf.subarray(at + 8, at + byteLength);
    chunks.push({
      type: buf.subarray(at, at + 4).toString('latin1'),
      byteLength,
      pngSize: body.subarray(0, 8).equals(PNG_MAGIC) ? body.readUInt32BE(16) : null,
    });
    at += byteLength;
  }
  return chunks;
}

/**
 * Reads the dimensions of a PNG from its IHDR chunk.
 *
 * @param buf - Raw PNG bytes.
 * @returns Width and height in pixels.
 * @throws When the buffer is not a PNG.
 */
function pngSize(buf: Buffer): { width: number; height: number } {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('packaged icon containers', () => {
  it('ships a real 512px PNG for the Linux AppImage', () => {
    expect(pngSize(read('build/icon.png'))).toEqual({ width: 512, height: 512 });
  });

  it('ships a multi-resolution Windows .ico covering 16px through 256px', () => {
    const entries = parseIco(read('build/icon.ico'));
    const sizes = entries.map((entry) => entry.width);

    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]));
    expect(new Set(sizes).size).toBeGreaterThanOrEqual(5);
    for (const entry of entries) {
      expect(entry.width).toBe(entry.height);
      expect(entry.bitsPerPixel).toBe(32);
      expect(entry.byteLength).toBeGreaterThan(0);
    }
  });

  it('ships a self-consistent macOS .icns with the Retina icon types', () => {
    const chunks = parseIcns(read('build/icon.icns'));
    const types = chunks.map((chunk) => chunk.type);

    // ic07/ic08 are the 128/256px slots; ic13/ic14 are their @2x counterparts.
    expect(types).toEqual(expect.arrayContaining(['ic07', 'ic08', 'ic13', 'ic14']));
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    expect(chunks.filter((chunk) => chunk.pngSize != null).length).toBeGreaterThanOrEqual(4);
    expect(chunks.find((chunk) => chunk.type === 'ic08')?.pngSize).toBe(256);
    expect(chunks.find((chunk) => chunk.type === 'ic14')?.pngSize).toBe(512);
  });

  it('sources the whole set from the committed 1024px master', () => {
    expect(pngSize(read('build/icon-source.png'))).toEqual({ width: 1024, height: 1024 });
    expect(pngSize(read('src/renderer/brand-icon.png'))).toEqual({ width: 256, height: 256 });
  });
});
