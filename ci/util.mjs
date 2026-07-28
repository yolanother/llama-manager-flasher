// Llama Manager Flasher — shared helpers for the ci/ phase scripts.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Small, dependency-free utilities used by ci/build.mjs, ci/preflight.mjs and
// the per-platform ci/package-*.mjs scripts: run a shell command with
// inherited stdio (failing the process on non-zero exit), capture a command's
// stdout without throwing, resolve the repo root portably, and install
// dependencies with PHASE-SCOPED depth — script-less for test/build (no
// native toolchain needed), full scripted install for package. Every path is
// derived from this file's location — no absolute paths, so the scripts run
// identically on a developer machine and a CI node.

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
 * Runs a command and captures its output instead of failing the process.
 * Used for tool probing (docker / vswhere / python) where a missing binary
 * or non-zero exit is an expected, non-fatal outcome.
 *
 * @param {string} file - Executable to run (resolved through the shell on
 *   Windows so .cmd/.bat shims work).
 * @param {string[]} [args] - Arguments for the executable.
 * @returns {{ ok: boolean, stdout: string, stderr: string }} `ok` is true
 *   only when the process spawned AND exited 0; stdout/stderr are trimmed
 *   (empty string when the spawn itself failed).
 */
export function probe(file, args = []) {
  const r = spawnSync(file, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return {
    ok: !r.error && r.status === 0,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

/**
 * Installs dependencies WITHOUT lifecycle scripts when node_modules is
 * absent (clean checkout). The test and build phases only run vitest / tsc /
 * vite — pure TypeScript tooling — so no native gyp builds (and therefore no
 * VS Build Tools / Xcode CLT / python) are required. Idempotent and cheap
 * when dependencies are already present.
 */
export function ensureDeps() {
  if (!existsSync(path.join(repoRoot, 'node_modules'))) {
    run('pnpm install --frozen-lockfile --ignore-scripts');
  }
}

/**
 * Installs dependencies WITH lifecycle scripts (native gyp builds, electron
 * download) for the package phase. Always runs `pnpm install` — even when
 * node_modules exists — because an earlier phase may have installed with
 * --ignore-scripts on the same checkout; pnpm records those skipped builds
 * in node_modules and a plain install re-runs them. A follow-up
 * `pnpm rebuild` guards the case where pnpm considers the install up-to-date
 * and skips the previously-ignored build scripts anyway. Requires the native
 * toolchain that ci/preflight.mjs verifies.
 *
 * CI=true is forced for the install: switching a node_modules that a prior
 * phase populated with --ignore-scripts over to a full scripted install makes
 * pnpm want to replace the modules dir, which it refuses without a TTY
 * (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`) unless CI is set. Setting it
 * here keeps the direct build (and the docker path's --no-docker fallback)
 * working regardless of the runner's ambient environment.
 */
export function ensureFullDeps() {
  run('pnpm install --frozen-lockfile', { CI: 'true' });
  run('pnpm rebuild', { CI: 'true' });
}
