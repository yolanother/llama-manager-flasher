// Llama Manager Flasher — platform backdrop interaction tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformDataValue } from '../src/renderer/App';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(root, 'src/renderer/index.css'), 'utf8');
const appSource = readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');

const image = (platformId: 'amd' | 'nvidia-spark'): Pick<ApplianceImage, 'platformId'> => ({ platformId });

describe('platform-responsive backdrop', () => {
  it('is neutral before a platform is selected', () => {
    expect(platformDataValue(null, null)).toBeUndefined();
    expect(css).toMatch(/body::before\s*\{[^}]*filter:\s*grayscale\(1\)/s);
  });

  it('retains pointer and keyboard previews on the initial platform page', () => {
    expect(css).toContain('body:has(.card-amd:hover)');
    expect(css).toContain('body:has(.card-amd:focus-visible)');
    expect(css).toContain('body:has(.card-nvidia:hover)');
    expect(css).toContain('body:has(.card-nvidia:focus-visible)');
  });

  it('selecting AMD persists the red platform value', () => {
    expect(platformDataValue(null, 'amd')).toBe('amd');
    expect(platformDataValue(image('amd'), null)).toBe('amd');
    expect(css).toContain('body:has(.shell[data-platform="amd"])');
    expect(css).toMatch(/--platform-tint:\s*rgba\(237,\s*28,\s*36,/);
  });

  it('selecting NVIDIA persists the green platform value', () => {
    expect(platformDataValue(null, 'nvidia-spark')).toBe('nvidia-spark');
    expect(platformDataValue(image('nvidia-spark'), null)).toBe('nvidia-spark');
    expect(css).toContain('body:has(.shell[data-platform="nvidia-spark"])');
    expect(css).toMatch(/--platform-tint:\s*rgba\(118,\s*185,\s*0,/);
  });

  it('derives subsequent-step tint from the retained image', () => {
    expect(appSource).toContain('data-platform={platformDataValue(image, manifestLoading)}');
    expect(platformDataValue(image('amd'), null)).toBe('amd');
    expect(platformDataValue(image('nvidia-spark'), null)).toBe('nvidia-spark');
  });

  it('reset removes the selected image and returns to neutral platform selection', () => {
    expect(appSource).toMatch(/const reset[\s\S]*setStep\('platform'\);[\s\S]*setImage\(null\)/);
    expect(platformDataValue(null, null)).toBeUndefined();
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
