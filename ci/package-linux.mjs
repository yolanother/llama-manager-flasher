// Llama Manager Flasher — CI package phase (Linux).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Builds the app and packages the Linux AppImage into dist-installer/,
// then asserts the artifact exists under EXACTLY the versionless name the
// marketing site hard-links (LlamaManagerFlasher-linux-x86_64.AppImage).
// Runnable locally with `node ci/package-linux.mjs`.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { run, ensureDeps, repoRoot } from './util.mjs';

ensureDeps();
run('pnpm build');
run('pnpm exec electron-builder --linux --publish never');

const artifact = path.join(repoRoot, 'dist-installer', 'LlamaManagerFlasher-linux-x86_64.AppImage');
if (!existsSync(artifact)) {
  console.error(`[ci] expected artifact missing: ${artifact}`);
  process.exit(1);
}
console.log(`[ci] packaged ${artifact} (${statSync(artifact).size} bytes)`);
