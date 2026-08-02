// Llama Manager Flasher — unit tests for artifact-name mapping.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Locks down the exact, versionless installer filenames the marketing site
// hard-links, and cross-checks package.json's electron-builder artifactName
// templates so a config edit cannot silently drift away from those names.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ARTIFACT_NAMES,
  artifactNameFor,
  buildPlatformFromNode,
} from '../src/shared/artifacts';

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

describe('artifact name mapping', () => {
  it('ships the Windows helper hotfix as v0.1.8', () => {
    expect(pkg.version).toBe('0.1.8');
  });

  it('produces the exact versionless names the site links', () => {
    expect(artifactNameFor('windows')).toBe('LlamaManagerFlasher-win-x64-portable.exe');
    expect(artifactNameFor('mac')).toBe('LlamaManagerFlasher-mac-arm64.dmg');
    expect(artifactNameFor('linux')).toBe('LlamaManagerFlasher-linux-x86_64.AppImage');
  });

  it('never embeds a version in any artifact name', () => {
    for (const name of Object.values(ARTIFACT_NAMES)) {
      expect(name).not.toContain(pkg.version);
      expect(name).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it('rejects unknown platforms', () => {
    expect(() => artifactNameFor('freebsd')).toThrow(/unknown build platform/);
  });

  it('maps node process.platform values to build platforms', () => {
    expect(buildPlatformFromNode('linux')).toBe('linux');
    expect(buildPlatformFromNode('darwin')).toBe('mac');
    expect(buildPlatformFromNode('win32')).toBe('windows');
    expect(() => buildPlatformFromNode('sunos')).toThrow(/unsupported build OS/);
  });

  it('matches the electron-builder artifactName templates in package.json', () => {
    const expand = (template: string, ext: string): string =>
      template.replace('${ext}', ext);
    expect(expand(pkg.build.win.artifactName, 'exe')).toBe(ARTIFACT_NAMES.windows);
    expect(expand(pkg.build.mac.artifactName, 'dmg')).toBe(ARTIFACT_NAMES.mac);
    expect(expand(pkg.build.linux.artifactName, 'AppImage')).toBe(ARTIFACT_NAMES.linux);
  });
});
