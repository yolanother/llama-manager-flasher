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
//   uid/gid so the checkout never accrues root-owned files; corepack is
//   enabled into /tmp/bin to work without root. libfuse is NOT needed:
//   electron-builder only assembles the AppImage, it never mounts it.
//   When docker is missing/unusable the script logs the reason and falls
//   back to the direct path.
// - --no-docker: direct on-host build (also the in-container entry point):
//   full scripted install, pnpm build, electron-builder.
//
// Runnable locally with `node ci/package-linux.mjs` (docker preferred) or
// `node ci/package-linux.mjs --no-docker` (direct).

import { existsSync, statSync } from 'node:fs';
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

const noDocker = process.argv.includes('--no-docker');

if (!noDocker) {
  const docker = detectDocker();
  if (docker.available && docker.osType === 'linux') {
    console.log('[ci] docker available — packaging inside node:22-bookworm container.');
    // Non-root inside the container (host uid/gid): HOME goes to /tmp/home,
    // corepack enables pnpm into /tmp/bin (no root needed), and the download
    // prompt is disabled so the pinned packageManager pnpm fetches silently.
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
    // NOTE: \\$PATH keeps the host shell from expanding $PATH — it must be
    // expanded by bash INSIDE the container. CI=true lets pnpm replace a
    // node_modules dir installed with different settings (e.g. a host
    // --ignore-scripts install) without prompting for a TTY.
    const inner = 'mkdir -p /tmp/home /tmp/bin' +
      ' && corepack enable --install-directory /tmp/bin pnpm' +
      ' && export PATH=/tmp/bin:\\$PATH' +
      ' && pnpm install --frozen-lockfile' +
      ' && node ci/package-linux.mjs --no-docker';
    // --tmpfs /tmp:exec is REQUIRED: HOME=/tmp/home holds pnpm's corepack
    // cache, whose bundled node-gyp runs gyp_main.py via its shebang during
    // the native gyp builds (drivelist/mountutils/...). Docker daemons that
    // mount the container's /tmp noexec (observed on the linux CI node, but
    // not on a stock local dockerd) make that exec fail with "Permission
    // denied" / make Error 126. Mounting /tmp as an explicit exec tmpfs
    // guarantees the cache is executable regardless of daemon defaults;
    // size=4g is ample for the deps + electron download on the RAM-rich box.
    run(
      `docker run --rm -u ${uid}:${gid}` +
      ' --tmpfs /tmp:rw,exec,nosuid,mode=1777,size=4g' +
      ' -e HOME=/tmp/home -e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0' +
      // node-gyp regenerates makefiles by execing gyp_main.py; with npm_config_python
      // unset it tries to run the .py directly from the read-only corepack cache and
      // hits `gyp_main.py: Permission denied` (Error 126). Pinning the interpreter
      // makes node-gyp invoke `python3 gyp_main.py` instead. python3 ships in
      // node:22-bookworm (full image).
      ' -e npm_config_python=/usr/bin/python3' +
      ` -v "${repoRoot}":/w -w /w node:22-bookworm` +
      ` bash -lc "${inner}"`,
    );
    assertArtifact();
    process.exit(0);
  }
  console.log(`[ci] ${docker.reason || `docker OSType=${docker.osType} unusable`} — falling back to direct host build.`);
}

ensureFullDeps();
run('pnpm build');
run('pnpm exec electron-builder --linux --publish never');
assertArtifact();
