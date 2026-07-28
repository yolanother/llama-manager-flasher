// Llama Manager Flasher — CI package phase (macOS).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Builds the app and packages the universal macOS dmg into dist-installer/,
// then asserts the artifact exists under EXACTLY the versionless name the
// marketing site hard-links (LlamaManagerFlasher-mac-universal.dmg).
// Notarization runs inside electron-builder's afterSign hook when APPLE_ID /
// APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are present in the environment,
// and is skipped with a warning otherwise. Runnable locally (on a mac) with
// `node ci/package-mac.mjs`.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { run, ensureDeps, repoRoot } from './util.mjs';

ensureDeps();
run('pnpm build');
run('pnpm exec electron-builder --mac --publish never');

const artifact = path.join(repoRoot, 'dist-installer', 'LlamaManagerFlasher-mac-universal.dmg');
if (!existsSync(artifact)) {
  console.error(`[ci] expected artifact missing: ${artifact}`);
  process.exit(1);
}
console.log(`[ci] packaged ${artifact} (${statSync(artifact).size} bytes)`);
