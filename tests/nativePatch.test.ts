// Llama Manager Flasher — cross-platform direct-io patch contract tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Locks the native @ronomon/direct-io patch to the layout required by both
// Linux make and Windows MSBuild: the broken gyp copy target stays removed,
// package resolution points at build/Release, and the V8-cage buffer fix remains.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const patch = readFileSync(path.join(root, 'patches/ronomon-direct-io-v8-cage.patch'), 'utf8');

describe('@ronomon/direct-io patch', () => {
  it('keeps the V8-managed buffer compatibility fix', () => {
    expect(patch).toContain('napi_create_buffer_copy');
  });

  it('removes the gyp copy target that generates an invalid Linux makefile', () => {
    expect(patch).toContain('diff --git a/binding.gyp b/binding.gyp');
    expect(patch).toContain('-      "target_name": "copy"');
  });

  it('loads the compiled binding from build/Release on every OS', () => {
    expect(patch).toContain('diff --git a/package.json b/package.json');
    expect(patch).toContain('+  "main": "build/Release/binding.node"');
  });
});
