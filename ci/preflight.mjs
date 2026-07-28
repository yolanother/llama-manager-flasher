// Llama Manager Flasher — CI package-phase preflight: native-toolchain check
// and best-effort dependency resolution.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Runs FIRST in the package phase (see .doubtech-ci.yml), before the full
// scripted `pnpm install` and electron-builder, and answers one question per
// OS: "can this node compile the native gyp modules (@ronomon/direct-io,
// drivelist, ...) that the packaged app needs?"
//
// - linux:   prefers Docker (`docker info --format {{.OSType}}`). When a
//            linux-container docker is available the package build runs
//            inside a node:22-bookworm container (ci/package-linux.mjs
//            default path) and NO host toolchain is needed. Without docker,
//            checks for cc/make/python3 and fails with the apt packages to
//            install.
// - windows: locates Visual Studio Build Tools (vswhere) + Python. When
//            missing, attempts a best-effort auto-install via choco, then
//            winget, re-checks, and otherwise exits with a crisp actionable
//            error. NOTE: docker cannot substitute here — Docker Desktop on
//            Windows runs LINUX containers, which cannot build Windows
//            Electron targets, so a real host toolchain is mandatory.
// - mac:     checks Xcode Command Line Tools (`xcode-select -p`) + python3;
//            there is no unattended CLT install, so it points the operator at
//            `xcode-select --install` and exits with a crisp error.
//
// Exit 0 = the package phase can proceed; exit 1 = toolchain missing and the
// error output says exactly what to install. Pure Node, no POSIX-isms —
// runnable as `node ci/preflight.mjs` on any of the three CI platforms.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from './util.mjs';

/**
 * Detects a usable Docker engine and reports the container OS type.
 *
 * @returns {{ available: boolean, osType: string, reason: string }} When
 *   `available` is false, `reason` explains why (binary missing, daemon
 *   unreachable). `osType` is docker's `{{.OSType}}` (e.g. "linux") when
 *   available.
 */
export function detectDocker() {
  const r = probe('docker', ['info', '--format', '{{.OSType}}']);
  if (!r.ok) {
    const reason = r.stderr || r.stdout || 'docker binary not found';
    return { available: false, osType: '', reason: `docker unavailable: ${reason.split('\n')[0]}` };
  }
  return { available: true, osType: r.stdout, reason: '' };
}

/**
 * Locates a Python interpreter suitable for node-gyp.
 *
 * @returns {string} A human-readable version string (e.g. "Python 3.12.4"),
 *   or empty string when no working interpreter was found. Guards against
 *   the Windows Store `python.exe` stub, which exits non-zero.
 */
function findPython() {
  for (const [cmd, args] of [
    ['python3', ['--version']],
    ['python', ['--version']],
    ['py', ['-3', '--version']],
  ]) {
    const r = probe(cmd, args);
    if (r.ok && /^Python \d/.test(r.stdout || r.stderr)) return r.stdout || r.stderr;
  }
  return '';
}

/**
 * Locates a Visual Studio (Build Tools or full VS) installation with the
 * C++ workload, via vswhere when present, falling back to a configured
 * `npm config get msvs_version` / default install-path probing.
 *
 * @returns {string} The VS installation path (or a descriptive marker when
 *   found only via msvs_version), empty string when not found.
 */
function findVsBuildTools() {
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (existsSync(vswhere)) {
    const r = probe(`"${vswhere}"`, [
      '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-latest',
      '-property', 'installationPath',
    ]);
    if (r.ok && r.stdout) return r.stdout.split('\n')[0].trim();
  }
  // Fallback probes for nodes without vswhere: an explicitly configured
  // msvs_version, then well-known BuildTools install locations.
  const msvs = probe('npm', ['config', 'get', 'msvs_version']);
  if (msvs.ok && /^\d{4}$/.test(msvs.stdout)) return `msvs_version=${msvs.stdout} (npm config)`;
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  for (const base of [programFiles, programFilesX86]) {
    for (const edition of ['BuildTools', 'Community', 'Professional', 'Enterprise']) {
      for (const year of ['2022', '2019']) {
        const p = path.join(base, 'Microsoft Visual Studio', year, edition, 'VC', 'Tools', 'MSVC');
        if (existsSync(p)) return path.dirname(path.dirname(p));
      }
    }
  }
  return '';
}

/**
 * Windows preflight: verify VS Build Tools + Python, attempting best-effort
 * auto-install via choco (preferred) or winget when either is missing, then
 * re-checking. Exits 1 with an actionable message when still missing.
 */
function preflightWindows() {
  let vs = findVsBuildTools();
  let py = findPython();
  console.log(`[preflight] windows: VS Build Tools ${vs ? `found (${vs})` : 'MISSING'}; Python ${py ? `found (${py})` : 'MISSING'}`);
  if (vs && py) return;

  // Best-effort auto-install. choco first (single command covers both), then
  // winget equivalents. Both need an elevated shell to actually succeed —
  // failures fall through to the actionable error below.
  if (probe('choco', ['--version']).ok) {
    console.log('[preflight] attempting auto-install via choco (requires elevation)...');
    const pkgs = [
      ...(py ? [] : ['python']),
      ...(vs ? [] : ['visualstudio2022buildtools', 'visualstudio2022-workload-vctools']),
    ].join(' ');
    const r = probe('choco', ['install', '-y', ...pkgs.split(' ')]);
    console.log(r.stdout.slice(-2000) || r.stderr.slice(-2000));
  } else if (probe('winget', ['--version']).ok) {
    console.log('[preflight] attempting auto-install via winget (requires elevation)...');
    if (!py) {
      const r = probe('winget', ['install', '-e', '--id', 'Python.Python.3.12', '--silent',
        '--accept-package-agreements', '--accept-source-agreements']);
      console.log(r.stdout.slice(-1000) || r.stderr.slice(-1000));
    }
    if (!vs) {
      const r = probe('winget', ['install', '-e', '--id', 'Microsoft.VisualStudio.2022.BuildTools', '--silent',
        '--accept-package-agreements', '--accept-source-agreements',
        '--override', '"--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"']);
      console.log(r.stdout.slice(-1000) || r.stderr.slice(-1000));
    }
  } else {
    console.log('[preflight] neither choco nor winget found — cannot auto-install.');
  }

  vs = findVsBuildTools();
  py = findPython();
  if (vs && py) {
    console.log('[preflight] auto-install succeeded; toolchain now present.');
    return;
  }
  console.error(
    '[preflight] FATAL: Windows native toolchain missing — the package phase compiles\n' +
    '  @ronomon/direct-io / drivelist and needs, on this node:\n' +
    (vs ? '' : '    - Visual Studio 2022 Build Tools with the "Desktop development with C++"\n' +
               '      workload:  choco install -y visualstudio2022buildtools visualstudio2022-workload-vctools\n' +
               '      (or winget install Microsoft.VisualStudio.2022.BuildTools with the VCTools workload)\n') +
    (py ? '' : '    - Python 3:  choco install -y python   (or winget install Python.Python.3.12)\n') +
    '  Run the installs from an ELEVATED shell, then re-run this build.\n' +
    '  Note: docker on Windows runs Linux containers and CANNOT build Windows\n' +
    '  Electron targets — a host toolchain is required.');
  process.exit(1);
}

/**
 * macOS preflight: verify Xcode Command Line Tools + python3. There is no
 * unattended CLT installer, so this only points the operator at
 * `xcode-select --install` and exits 1 when absent.
 */
function preflightMac() {
  const clt = probe('xcode-select', ['-p']);
  const py = findPython();
  console.log(`[preflight] mac: Xcode CLT ${clt.ok ? `found (${clt.stdout})` : 'MISSING'}; Python ${py ? `found (${py})` : 'MISSING'}`);
  if (clt.ok && py) return;
  console.error(
    '[preflight] FATAL: macOS native toolchain missing — the package phase compiles\n' +
    '  @ronomon/direct-io / drivelist under @electron/rebuild and needs:\n' +
    (clt.ok ? '' : '    - Xcode Command Line Tools: run `xcode-select --install` on the node\n' +
                   '      (GUI prompt; there is no unattended install) or install full Xcode.\n') +
    (py ? '' : '    - python3 (ships with the CLT; `python3 --version` must work).\n') +
    '  Install the above on the mac node, then re-run this build.');
  process.exit(1);
}

/**
 * Linux preflight: prefer docker (the package build then runs containerized
 * and needs no host toolchain); without docker, require cc/make/python3 on
 * the host and fail with the apt packages to install.
 */
function preflightLinux() {
  const docker = detectDocker();
  if (docker.available && docker.osType === 'linux') {
    console.log(`[preflight] linux: docker available (OSType=${docker.osType}) — package build will run in an isolated node:22-bookworm container; no host toolchain needed.`);
    return;
  }
  console.log(`[preflight] linux: ${docker.available ? `docker OSType=${docker.osType} unusable` : docker.reason} — falling back to host toolchain check.`);
  const cc = probe('cc', ['--version']).ok || probe('gcc', ['--version']).ok;
  const make = probe('make', ['--version']).ok;
  const py = findPython();
  console.log(`[preflight] linux host: cc ${cc ? 'found' : 'MISSING'}; make ${make ? 'found' : 'MISSING'}; Python ${py ? `found (${py})` : 'MISSING'}`);
  if (cc && make && py) return;
  console.error(
    '[preflight] FATAL: Linux native toolchain missing and docker unavailable.\n' +
    '  Either install docker (preferred — the build then runs fully containerized):\n' +
    '    sudo apt-get install -y docker.io   # or docker-ce\n' +
    '  or install the host toolchain:\n' +
    '    sudo apt-get install -y build-essential python3\n' +
    '  then re-run this build.');
  process.exit(1);
}

// Run the checks only when invoked directly (`node ci/preflight.mjs`) —
// ci/package-linux.mjs imports detectDocker() from this module and must not
// re-trigger the full preflight on import.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const byPlatform = { linux: preflightLinux, darwin: preflightMac, win32: preflightWindows };
  const fn = byPlatform[process.platform];
  if (!fn) {
    console.error(`[preflight] unsupported OS: ${process.platform}`);
    process.exit(1);
  }
  fn();
  console.log('[preflight] OK — package phase may proceed.');
}
