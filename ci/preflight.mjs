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

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, probeRaw, repoRoot } from './util.mjs';

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
 * Interrogates one Python invocation for its REAL absolute interpreter path
 * and version in a single call. Asking Python for `sys.executable` (a) proves
 * it is a genuine working interpreter rather than the Windows Store
 * app-execution-alias stub (which produces no usable output / opens the Store
 * in non-interactive contexts), and (b) yields an absolute path we can pin so
 * node-gyp works even when the CI agent's PATH is stale.
 *
 * @param {string} cmd Executable to invoke (a bare name or an absolute path).
 * @param {string[]} preArgs Leading args (e.g. `['-3']` for the `py` launcher).
 * @returns {{ exe: string, version: string } | null} Resolved interpreter, or null.
 */
function pythonInfo(cmd, preArgs = []) {
  // probeRaw (shell:false) — the `-c` one-liner contains `|`/`"`/`;`/`()` which
  // a Windows shell:true spawn would mangle (the `|` becomes a pipe), which is
  // exactly why a present, working Python previously read as MISSING.
  const r = probeRaw(cmd, [...preArgs, '-c',
    'import sys;print(sys.executable+"|"+sys.version.split()[0])']);
  const out = (r.stdout || '').trim();
  if (r.ok && out.includes('|')) {
    const exe = (out.split('|')[0] || '').trim();
    const ver = out.split('|')[1] || '';
    // REJECT a Store Python: its interpreter resolves under ...\WindowsApps\...
    // and node-gyp cannot use it — it is only launchable via the PATH-resolved
    // app-execution-alias, never by a concrete path we can pin. Returning null
    // makes every probe skip it and fall through to a real install (a
    // python.org Program Files interpreter found via PATH / registry
    // ExecutablePath / the on-disk Program Files scan).
    if (exe && /[\\/]WindowsApps[\\/]/i.test(exe)) return null;
    // Otherwise, do NOT require existsSync(exe): if it RAN and reported a
    // version it exists and works.
    if (exe && /^\d+\.\d+/.test(ver)) return { exe, version: `Python ${ver}` };
  }
  return null;
}

/**
 * Locates a real Python interpreter suitable for node-gyp, robust to a stale
 * agent PATH and the Windows Store stub. Tries, in order: the `py` launcher
 * (always on PATH when Python is installed), `python3`/`python` on PATH, and
 * finally well-known install directories discovered directly on disk.
 *
 * @returns {{ exe: string, version: string } | null} The resolved interpreter, or null.
 */
/**
 * Discovers installed Pythons via the Windows registry (PEP 514), independent
 * of PATH. Covers the case a bare-PATH probe cannot: a Microsoft Store Python
 * (or any install) present on a CI agent whose PATH is stale from before the
 * install. Reads `HK{CU,LM}\Software\Python\**` for `ExecutablePath` /
 * `InstallPath` and validates each candidate via {@link pythonInfo}.
 *
 * @returns {{ exe: string, version: string } | null} Resolved interpreter, or null.
 */
function findPythonViaRegistry() {
  if (process.platform !== 'win32') return null;
  for (const hive of ['HKCU', 'HKLM']) {
    const r = probe('reg', ['query', `${hive}\\Software\\Python`, '/s']);
    if (!r.ok || !r.stdout) continue;
    const candidates = [];
    const lines = r.stdout.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // python.org registers an explicit `ExecutablePath` value pointing at python.exe.
      let m = line.match(/^\s*ExecutablePath\s+REG_SZ\s+(.+?\.exe)\s*$/i);
      if (m) { candidates.push(m[1].trim()); continue; }
      // Every real install has an `InstallPath` KEY whose `(Default)` value is the
      // install dir (Store Python included) — read the (Default) on a nearby line.
      if (/\\InstallPath\s*$/i.test(line)) {
        for (let k = i + 1; k < Math.min(i + 5, lines.length); k++) {
          const dm = lines[k].match(/^\s*\(Default\)\s+REG_SZ\s+(.+?)\s*$/i);
          if (dm) { candidates.push(path.join(dm[1].trim(), 'python.exe')); break; }
        }
      }
    }
    // Try running each candidate directly — do NOT existsSync-gate (WindowsApps
    // denies stat but permits exec for the owning user).
    for (const exe of candidates) {
      const info = pythonInfo(exe);
      if (info) return info;
    }
  }
  return null;
}

function findPython() {
  // Prefer stable, node-gyp-supported minors (3.12/3.11/3.10) over whatever
  // `py -3` defaults to (a box may have a too-new 3.14 that node-gyp rejects),
  // then fall back to generic launcher/PATH names.
  for (const [cmd, pre] of [
    ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']],
    ['py', ['-3']], ['python3', []], ['python', []],
  ]) {
    const info = pythonInfo(cmd, pre);
    if (info) return info;
  }
  // (A Store Python under %LOCALAPPDATA%\Microsoft\WindowsApps is intentionally
  // NOT probed: pythonInfo rejects any WindowsApps-resolved interpreter because
  // node-gyp cannot use it. A real interpreter is required — see below.)
  // Windows registry (PEP 514) — finds a real Python even with a stale PATH.
  const reg = findPythonViaRegistry();
  if (reg) return reg;
  // PATH may be stale (agent launched before Python was installed) — probe the
  // canonical install roots directly for a `Python3x\python.exe`.
  const roots = [];
  const la = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pfx = process.env['ProgramFiles(x86)'];
  if (la) roots.push(path.join(la, 'Programs', 'Python'));
  if (pf) roots.push(path.join(pf, 'Python'), pf);
  if (pfx) roots.push(pfx);
  roots.push('C:\\');
  for (const root of roots) {
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!/^Python3/i.test(name)) continue;
      const exe = path.join(root, name, 'python.exe');
      if (existsSync(exe)) {
        const info = pythonInfo(exe);
        if (info) return info;
      }
    }
  }
  return null;
}

/**
 * Pins node-gyp's Python interpreter to an absolute path by writing a `python`
 * entry into a project-root `.npmrc`. Preflight and the package build run as
 * SEPARATE processes, so an env var set here would not survive; `.npmrc` is
 * read by pnpm/npm and honored by node-gyp in the subsequent package step,
 * making the native build immune to a stale agent PATH. Idempotent.
 *
 * @param {string} exe Absolute path to a real python.exe.
 */
function pinPythonForNodeGyp(exe) {
  const npmrc = path.join(repoRoot, '.npmrc');
  let body = '';
  try { body = readFileSync(npmrc, 'utf8'); } catch { /* none yet */ }
  const line = `python=${exe.replace(/\\/g, '/')}`;
  const next = body
    .split(/\r?\n/)
    .filter((l) => l && !/^python=/.test(l))
    .concat(line)
    .join('\n') + '\n';
  writeFileSync(npmrc, next);
  console.log(`[preflight] pinned node-gyp python -> ${exe} (via .npmrc)`);
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
  console.log(`[preflight] windows: VS Build Tools ${vs ? `found (${vs})` : 'MISSING'}; Python ${py ? `found (${py.version} @ ${py.exe})` : 'MISSING'}`);
  if (vs && py) { pinPythonForNodeGyp(py.exe); return; }

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
    pinPythonForNodeGyp(py.exe);
    return;
  }
  if (!py) {
    // Ground-truth diagnostics: dump exactly what THIS process (the CI agent's
    // env) can see, so a Python that "is installed" but undiscovered can be
    // pinpointed — PATH-independent reg included.
    console.error('[preflight] --- Python discovery diagnostics (agent env) ---');
    for (const [label, cmd, args] of [
      ['py -0p (launcher list)', 'py', ['-0p']],
      ['where py', 'where', ['py']],
      ['where python', 'where', ['python']],
      ['reg PythonCore (HKCU)', 'reg', ['query', 'HKCU\\Software\\Python', '/s']],
      ['reg PythonCore (HKLM)', 'reg', ['query', 'HKLM\\Software\\Python', '/s']],
    ]) {
      const r = probe(cmd, args);
      const out = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 800) || '(no output)';
      console.error(`[preflight]   $ ${cmd} ${args.join(' ')}  => exit ${r.ok ? 0 : 'nonzero'}\n${out}`);
    }
    console.error(`[preflight]   PATH=${(process.env.PATH || process.env.Path || '').slice(0, 600)}`);
    console.error('[preflight] --- end diagnostics ---');
  }
  console.error(
    '[preflight] FATAL: Windows native toolchain missing — the package phase compiles\n' +
    '  @ronomon/direct-io / drivelist and needs, on this node:\n' +
    (vs ? '' : '    - Visual Studio 2022 Build Tools with the "Desktop development with C++"\n' +
               '      workload:  choco install -y visualstudio2022buildtools visualstudio2022-workload-vctools\n' +
               '      (or winget install Microsoft.VisualStudio.2022.BuildTools with the VCTools workload)\n') +
    (py ? '' : '    - Python 3:  install from python.org (tick "Add to PATH") or the Store,\n' +
               '      then RESTART the DoubTech CI node agent. If Python IS installed but\n' +
               '      still shows MISSING here, the agent has a stale PATH from before the\n' +
               '      install — restarting the agent is the fix (this preflight also probes\n' +
               '      the py launcher + known install dirs, so a restart usually suffices).\n') +
    '  Run any installs from an ELEVATED shell, then re-run this build.\n' +
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
  console.log(`[preflight] mac: Xcode CLT ${clt.ok ? `found (${clt.stdout})` : 'MISSING'}; Python ${py ? `found (${py.version})` : 'MISSING'}`);
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
  console.log(`[preflight] linux host: cc ${cc ? 'found' : 'MISSING'}; make ${make ? 'found' : 'MISSING'}; Python ${py ? `found (${py.version})` : 'MISSING'}`);
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
