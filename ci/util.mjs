// Llama Manager Flasher — shared helpers for the ci/ phase scripts.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Small, dependency-free utilities used by ci/build.mjs and the per-platform
// ci/package-*.mjs scripts: run a shell command with inherited stdio (failing
// the process on non-zero exit), resolve the repo root portably, and make
// sure node_modules exists on a clean checkout. Every path is derived from
// this file's location — no absolute paths, so the scripts run identically
// on a developer machine and a CI node.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root (parent of ci/). */
export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs a command with inherited stdio from the repo root; exits the process
 * with the child's status on failure so CI phases fail loudly.
 *
 * @param {string} cmd - The command line to run (executed through the shell
 *   so `pnpm` resolves on every platform).
 * @param {Record<string, string>} [extraEnv] - Extra environment variables.
 */
export function run(cmd, extraEnv = {}) {
  console.log(`[ci] $ ${cmd}`);
  const r = spawnSync(cmd, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) {
    console.error(`[ci] command failed (${r.status}): ${cmd}`);
    process.exit(r.status ?? 1);
  }
}

/**
 * Installs dependencies when node_modules is absent (clean checkout).
 * Idempotent and cheap when dependencies are already present.
 */
export function ensureDeps() {
  if (!existsSync(path.join(repoRoot, 'node_modules'))) {
    run('pnpm install --frozen-lockfile');
  }
}
