// Llama Manager Flasher — CI package phase (Linux).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Packages the Linux AppImage into dist-installer/ and asserts the artifact
// exists under EXACTLY the versionless name the marketing site hard-links
// (LlamaManagerFlasher-linux-x86_64.AppImage). Two paths:
//
// - DEFAULT: when a linux-container docker engine is available, the whole
//   build (scripted pnpm install + native gyp builds + electron-builder)
//   runs INSIDE a node:22-bookworm container for isolation from host state —
//   the container re-invokes this script with --no-docker. Runs as the host
//   uid/gid so the checkout never accrues root-owned files. libfuse is NOT
//   needed: electron-builder only assembles the AppImage, it never mounts it.
//   The container build is best-effort: if docker is missing/unusable OR the
//   containerized build fails for ANY reason, the script logs the reason and
//   FALLS BACK to the direct host build so linux still produces the artifact.
// - --no-docker: direct on-host build (also the in-container entry point):
//   full scripted install, pnpm build, electron-builder.
//
// Runnable locally with `node ci/package-linux.mjs` (docker preferred) or
// `node ci/package-linux.mjs --no-docker` (direct).

import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { run, ensureFullDeps, repoRoot } from './util.mjs';
import { detectDocker } from './preflight.mjs';

/** Asserts the versionless AppImage artifact exists, exiting 1 otherwise. */
function assertArtifact() {
  const artifact = path.join(repoRoot, 'dist-installer', 'LlamaManagerFlasher-linux-x86_64.AppImage');
  if (!existsSync(artifact)) {
    console.error(`[ci] expected artifact missing: ${artifact}`);
    process.exit(1);
  }
  console.log(`[ci] packaged ${artifact} (${statSync(artifact).size} bytes)`);
}

/**
 * Runs the containerized package build. Non-fatal: returns the child's exit
 * status instead of exiting, so the caller can fall back to a direct host
 * build when the container build fails.
 *
 * @returns {number} 0 on success, non-zero on failure.
 */
function runDockerBuild() {
  // Non-root inside the container (host uid/gid) so the mounted checkout
  // never accrues root-owned files.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  // CRITICAL — HOME (the corepack + node-gyp cache) lives on the bind-mounted
  // /w, NOT on the container's /tmp. gyp's generated Makefiles regenerate
  // themselves with a rule that execve()s gyp_main.py directly via its
  // shebang (gyp-next emits a bare script path, not `python3 gyp_main.py`, so
  // npm_config_python cannot redirect it). Some hardened docker daemons mount
  // the container's /tmp noexec — even when `docker run --tmpfs /tmp:exec` is
  // requested — which makes that execve fail with "gyp_main.py: Permission
  // denied" / make Error 126 (observed on the linux CI node; not on a stock
  // local dockerd). Putting the cache under /w keeps gyp_main.py on the host
  // filesystem that already holds the (executable) checkout, so the execve is
  // permitted regardless of the daemon's /tmp policy. If it still fails, the
  // caller falls back to the direct host build.
  // NOTE: \\$PATH must be expanded by bash INSIDE the container, not the host
  // shell. CI=true lets pnpm replace a node_modules installed with different
  // settings (e.g. a prior host --ignore-scripts install) without a TTY.
  const inner = 'mkdir -p /w/.ci-home/bin' +
    ' && export HOME=/w/.ci-home' +
    ' && corepack enable --install-directory /w/.ci-home/bin pnpm' +
    ' && export PATH=/w/.ci-home/bin:\\$PATH' +
    ' && pnpm install --frozen-lockfile' +
    ' && node ci/package-linux.mjs --no-docker';
  const cmd =
    `docker run --rm -u ${uid}:${gid}` +
    ' -e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0' +
    // Belt-and-suspenders: pin the interpreter so node-gyp's own programmatic
    // gyp invocations use `python3 gyp_main.py` (ships in node:22-bookworm).
    ' -e npm_config_python=/usr/bin/python3' +
    ` -v "${repoRoot}":/w -w /w node:22-bookworm` +
    ` bash -lc "${inner}"`;
  console.log(`[ci] $ ${cmd}`);
  const r = spawnSync(cmd, { cwd: repoRoot, stdio: 'inherit', shell: true });
  return r.status ?? 1;
}

const noDocker = process.argv.includes('--no-docker');

if (!noDocker) {
  const docker = detectDocker();
  if (docker.available && docker.osType === 'linux') {
    console.log('[ci] docker available — packaging inside node:22-bookworm container.');
    const status = runDockerBuild();
    if (status === 0) {
      assertArtifact();
      process.exit(0);
    }
    console.warn(`[ci] containerized build failed (exit ${status}) — falling back to direct host build.`);
  } else {
    console.log(`[ci] ${docker.reason || `docker OSType=${docker.osType} unusable`} — falling back to direct host build.`);
  }
}

ensureFullDeps();
run('pnpm build');
run('pnpm exec electron-builder --linux --publish never');
assertArtifact();
