// Llama Manager Flasher — platform backdrop interaction tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Verifies the choose-platform page's visual contract: the photographic
// backdrop is grayscale at rest, AMD and NVIDIA interactions tint the whole
// scene with their hardware colors for both pointer and keyboard users, and
// people who request reduced motion receive an immediate transition.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src/renderer/index.css'),
  'utf8',
);

describe('platform-responsive backdrop', () => {
  it('is grayscale at rest and exposes pointer, focus, and reduced-motion states', () => {
    expect(css).toMatch(/body::before\s*\{[^}]*filter:\s*grayscale\(1\)/s);
    expect(css).toContain('body:has(.card-amd:hover)');
    expect(css).toContain('body:has(.card-amd:focus-visible)');
    expect(css).toMatch(/--platform-tint:\s*rgba\(237,\s*28,\s*36,/);
    expect(css).toContain('body:has(.card-nvidia:hover)');
    expect(css).toContain('body:has(.card-nvidia:focus-visible)');
    expect(css).toMatch(/--platform-tint:\s*rgba\(118,\s*185,\s*0,/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
