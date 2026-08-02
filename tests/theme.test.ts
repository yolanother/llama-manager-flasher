// Llama Manager Flasher — brand theme token tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Guards the renderer stylesheet's theming contract: the accent is a CSS custom
// property (never a literal at a use site), it defaults to the hardware-neutral
// `generic` cyan ramp, each platform scope re-points the whole ramp to that
// platform's colors, and every hex literal in the sheet belongs to the approved
// Llama Manager palette. Together these stop an off-brand color or a hardcoded
// accent from silently re-entering the UI.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(root, 'src/renderer/index.css'), 'utf8');

/** Structural tokens shared by every platform theme (see docs/THEMING.md). */
const STRUCTURAL = ['#0a0a0a', '#141414', '#1a1a1a', '#ffffff', '#a3a3a3', '#2a2a2a'];

/** Per-platform accent ramps: primary, bright, deep. */
const RAMPS = {
  generic: ['#00d3db', '#5fe9f0', '#067f86'],
  amd: ['#ed1c24', '#ff6a00', '#a31217'],
  nvidia: ['#76b900', '#8fd400', '#5a8c00'],
} as const;

/** Semantic status colors, kept outside the brand ramps by design. */
const STATUS = ['#22c55e', '#ff4d4f'];

/**
 * Extracts the body of the first rule whose selector list matches exactly.
 *
 * @param selector - Selector text as written in the stylesheet.
 * @returns The declarations between that rule's braces.
 * @throws When the stylesheet contains no such rule.
 */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for selector: ${selector}`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('brand theme tokens', () => {
  it('declares the shared structural palette on :root', () => {
    const body = ruleBody(':root');
    for (const hex of STRUCTURAL) expect(body).toContain(hex);
  });

  it('defaults the accent ramp to the generic cyan identity', () => {
    const body = ruleBody(':root');
    expect(body).toMatch(/--accent:\s*#00d3db;/);
    expect(body).toMatch(/--accent-bright:\s*#5fe9f0;/);
    expect(body).toMatch(/--accent-deep:\s*#067f86;/);
  });

  it('re-points the whole ramp for a selected AMD image', () => {
    const body = ruleBody('body:has(.shell[data-platform="amd"])');
    expect(body).toMatch(/--accent:\s*#ed1c24;/);
    expect(body).toMatch(/--accent-bright:\s*#ff6a00;/);
    expect(body).toMatch(/--accent-deep:\s*#a31217;/);
  });

  it('re-points the whole ramp for a selected NVIDIA image', () => {
    const body = ruleBody('body:has(.shell[data-platform="nvidia-spark"])');
    expect(body).toMatch(/--accent:\s*#76b900;/);
    expect(body).toMatch(/--accent-bright:\s*#8fd400;/);
    expect(body).toMatch(/--accent-deep:\s*#5a8c00;/);
  });

  it('previews a platform ramp while its card is hovered or focused', () => {
    for (const selector of [
      'body:has(.card-amd:hover),\nbody:has(.card-amd:focus-visible),\nbody:has(.card-amd:focus-within)',
      'body:has(.card-nvidia:hover),\nbody:has(.card-nvidia:focus-visible),\nbody:has(.card-nvidia:focus-within)',
    ]) {
      const body = ruleBody(selector);
      expect(body).toMatch(/--accent:/);
      expect(body).toMatch(/--accent-bright:/);
      expect(body).toMatch(/--accent-deep:/);
    }
  });

  it('drives every accented surface from the token, never a literal', () => {
    // Accent literals may only appear inside the ramp declarations themselves.
    const useSites = css
      .split('\n')
      .filter((line) => !/--accent(-bright|-deep)?:/.test(line) && !/--platform-tint/.test(line));
    for (const hex of [...RAMPS.generic, ...RAMPS.amd, ...RAMPS.nvidia]) {
      expect(useSites.join('\n')).not.toContain(hex);
    }

    for (const selector of ['.primary', '.steps li.active', '.phase.active', '.bar-fill']) {
      expect(ruleBody(selector)).toContain('var(--accent');
    }
  });

  it('contains no hex color outside the approved palette', () => {
    const allowed = new Set([...STRUCTURAL, ...Object.values(RAMPS).flat(), ...STATUS]);
    const found = new Set((css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((hex) => hex.toLowerCase()));
    expect([...found].filter((hex) => !allowed.has(hex))).toEqual([]);
  });
});
