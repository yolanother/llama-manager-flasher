// Llama Manager Flasher — CI build phase.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Runs the strict TypeScript typecheck across all three process configs
// (main / preload / renderer) and then the full production build (tsc emit +
// Vite renderer bundle). Runnable locally with `node ci/build.mjs` and on a
// clean CI checkout — dependencies are installed if missing.

import { run, ensureDeps } from './util.mjs';

ensureDeps();
run('pnpm typecheck');
run('pnpm build');
console.log('[ci] build phase complete');
