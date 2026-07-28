// Llama Manager Flasher — CI package phase dispatcher.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Selects the per-platform packaging script for the OS the CI node is
// running on (Windows step runners cannot expand $CI_NODE_PLATFORM the way
// POSIX shells do, so the dispatch happens in Node via process.platform) and
// executes it. Runnable locally with `node ci/package.mjs`.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const byPlatform = {
  linux: 'package-linux.mjs',
  darwin: 'package-mac.mjs',
  win32: 'package-windows.mjs',
};
const script = byPlatform[process.platform];
if (!script) {
  console.error(`[ci] unsupported packaging OS: ${process.platform}`);
  process.exit(1);
}
const r = spawnSync(process.execPath, [path.join(here, script)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
