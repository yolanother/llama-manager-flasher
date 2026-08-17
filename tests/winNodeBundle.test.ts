// Llama Manager Flasher — bundled Windows Node fetch/verify tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Guards the build-time supply chain for the node.exe the Windows build ships:
// the version is PINNED, the download is verified against the digest nodejs.org
// publishes in SHASUMS256.txt for that exact version, and a mismatch (or a
// missing entry) fails the build rather than silently shipping an unverified
// binary. Also pins the packaging config that puts node.exe where
// resolveHelperNode looks for it, and the manifest elevation the Windows
// launch path now depends on.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bundle = require(path.join(root, 'scripts/fetch-win-node.cjs')) as {
  NODE_VERSION: string;
  NODE_EXE_URL: string;
  SHASUMS_URL: string;
  DEST: string;
  digestFor: (shasums: string, entry: string) => string;
};
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const SHASUMS = [
  '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97  node-v22.23.2-win-x64.zip',
  '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4  win-x64/node.exe',
  'ac15f1e9d7c8279353723a77f6319967f1a41c06026521094a8234c2e6fbe052  win-x64/node.lib',
].join('\n');

describe('bundled Windows Node', () => {
  it('pins an exact version and derives both URLs from it', () => {
    expect(bundle.NODE_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(bundle.NODE_EXE_URL).toBe(`https://nodejs.org/dist/${bundle.NODE_VERSION}/win-x64/node.exe`);
    expect(bundle.SHASUMS_URL).toBe(`https://nodejs.org/dist/${bundle.NODE_VERSION}/SHASUMS256.txt`);
  });

  it('extracts the digest for the exact entry, not a prefix match', () => {
    expect(bundle.digestFor(SHASUMS, 'win-x64/node.exe'))
      .toBe('0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4');
    expect(bundle.digestFor(SHASUMS, 'win-x64/node.lib'))
      .toBe('ac15f1e9d7c8279353723a77f6319967f1a41c06026521094a8234c2e6fbe052');
  });

  it('throws when the entry is absent instead of returning a bogus digest', () => {
    expect(() => bundle.digestFor(SHASUMS, 'win-arm64/node.exe')).toThrow(/win-arm64\/node\.exe/);
    expect(() => bundle.digestFor('', 'win-x64/node.exe')).toThrow();
  });

  it('lands node.exe where resolveHelperNode looks in a dev checkout', () => {
    expect(bundle.DEST).toBe(path.join(root, 'build', 'win-node', 'node.exe'));
  });

  it('packages node.exe as a win-only extraResource at the resources root', () => {
    expect(pkg.build.win.extraResources).toEqual([
      { from: 'build/win-node/node.exe', to: 'node.exe' },
    ]);
    // Must NOT be a top-level extraResources — mac/linux use the system node.
    expect(pkg.build.extraResources).toBeUndefined();
    expect(pkg.build.beforePack).toBe('scripts/fetch-win-node.cjs');
  });

  it('requests administrator for BOTH the app exe and the portable wrapper', () => {
    // The inner exe's manifest…
    expect(pkg.build.win.requestedExecutionLevel).toBe('requireAdministrator');
    // …and the portable SFX that ExecWaits it. Without this the unelevated
    // wrapper cannot start a requireAdministrator child (ERROR_ELEVATION_REQUIRED).
    expect(pkg.build.portable.requestExecutionLevel).toBe('admin');
  });
});
