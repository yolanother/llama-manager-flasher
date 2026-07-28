<!--
  Llama Manager Flasher — project README.

  Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
  governed by the LICENSE file in the repository root.

  User- and developer-facing documentation for the standalone appliance-image
  flasher: what it does, how to run it per OS (including elevation and
  unsigned-binary caveats), how to build and test it, and how the DoubTech CI
  pipeline packages the three installers.
-->

# Llama Manager Flasher

A branded, standalone tool that puts the **Llama Manager appliance** onto a USB
stick or microSD card. Pick your platform, and the app downloads the **latest**
appliance image, verifies its SHA-256 checksum, writes it to the drive with
[etcher-sdk](https://github.com/balena-io-modules/etcher-sdk) (the Balena
Etcher engine), and verifies the write before telling you it is safe to boot
from.

Supported appliance platforms:

| Platform | Channel | Arch | Source |
|---|---|---|---|
| AMD Ryzen AI | **Stable** | amd64 | `llama-manager.doubtech.ai/downloads` (SHA256SUMS) |
| NVIDIA DGX Spark | **EXPERIMENTAL** — unvalidated on hardware | arm64 | `llama-manager.doubtech.ai/downloads-nvidia-spark` (release.json) |

## Download

Grab the installer for your OS (versionless "latest" names, linked from the
Llama Manager site):

- Windows: `LlamaManagerFlasher-win-x64-portable.exe`
- macOS: `LlamaManagerFlasher-mac-arm64.dmg`
- Linux: `LlamaManagerFlasher-linux-x86_64.AppImage`

## Usage

1. **Choose your platform** — AMD Ryzen AI (stable) or NVIDIA DGX Spark
   (experimental; expect rough edges, it has not been validated on hardware).
2. **Choose the target drive** — only removable USB / SD devices ≤ 2 TiB are
   listed; system disks are filtered out and re-checked in the privileged
   process right before writing.
3. **Confirm** — type the device path to confirm the destructive write.
4. Wait through **download → checksum → write → verify**. Downloads are cached
   (`image-cache/` under the app's user-data dir), resume over HTTP Range on
   retry, and are deleted on checksum mismatch.
5. When verification finishes the drive is unmounted and safe to unplug.

### Elevation / OS notes

Raw block-device writes need elevated rights:

- **Windows** — launch normally; when flashing without admin rights the app
  offers **Relaunch elevated** (UAC prompt via `Start-Process -Verb RunAs`).
- **Linux** — the app offers **Relaunch elevated** through `pkexec` (polkit).
  If pkexec is unavailable, run the AppImage with
  `sudo ./LlamaManagerFlasher-linux-x86_64.AppImage --no-sandbox`.
  (`--no-sandbox` is required when running Electron as root.)
- **macOS** — no relaunch needed: etcher-sdk opens devices through Apple's
  `authopen(1)`, which prompts for authorization per device.

### Unsigned-binary caveats (until signing credentials exist)

- **Windows SmartScreen** will warn that the portable exe is unrecognized —
  choose "More info → Run anyway".
- **macOS Gatekeeper** will block the unnotarized app — right-click → Open, or
  allow it under System Settings → Privacy & Security. Notarization is wired
  into the build (`scripts/notarize.cjs`) and activates automatically once
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are provided
  to the CI mac node.
- **Linux** AppImages are unaffected; mark it executable (`chmod +x`) and run.

This is a portable one-shot tool — it has **no auto-updater** by design.
The app version lives in the release tag and About line, never in the
artifact filename.

## Building from source

Requires Node 22+ and pnpm 10+.

```bash
pnpm install               # native deps build against your OS
pnpm test                  # vitest unit tests (manifest / safety / artifacts)
pnpm typecheck             # strict tsc across main / preload / renderer
pnpm build                 # tsc (main+preload) + vite (renderer)
pnpm start                 # run the built app
pnpm package:linux         # dist-installer/LlamaManagerFlasher-linux-x86_64.AppImage
pnpm package:win           # (on Windows) ...-win-x64-portable.exe
pnpm package:mac           # (on macOS)   ...-mac-arm64.dmg
pnpm gen-icons             # regenerate build/icon.{png,ico,icns} from icon.svg
```

### The `@ronomon/direct-io` patch

`patches/ronomon-direct-io-v8-cage.patch` (wired via
`pnpm.patchedDependencies`) is **required**. It does two things:

1. **V8 memory cage** — Electron ≥ 21 forbids `napi_create_external_buffer`;
   the patch switches the aligned-I/O buffer allocation to
   `napi_create_buffer_copy`. Without it, writes crash at runtime.
2. **Build fix under pnpm** — pnpm stores patched packages in a directory
   containing `patch_hash=`; the `=` breaks the make rules gyp generates for
   the package's `copy` target. The patch drops that target, points `main` at
   `build/Release/binding.node`, and neutralizes the `postinstall:
   node-gyp clean` that would have deleted the binary.

## CI

`.doubtech-ci.yml` (DoubTech CI, schema v1) runs on pushes to `main` across
linux / mac / windows nodes:

- **test** — `pnpm install --frozen-lockfile --ignore-scripts` + `pnpm
  test:ci` (JUnit XML at `reports/junit/test.xml`, aggregated via
  `testReports`).
- **build** — `node ci/build.mjs` (strict typecheck + production build; also
  installs script-less when needed).
- **package** — `node ci/preflight.mjs` (toolchain check / best-effort
  auto-install, see below) then `node ci/package.mjs`, which dispatches to
  `ci/package-{linux,mac,windows}.mjs`; each runs the FULL scripted install,
  builds, and emits exactly one versionless installer into `dist-installer/`,
  failing if the expected filename is missing. Collected via the
  `dist-installer/LlamaManagerFlasher-*` glob.

Every `ci/` script is a plain Node script, runnable locally from a clean
checkout — no absolute paths, version derived from `package.json`.

### Phase-scoped installs (why `--ignore-scripts`)

The test and build phases run only vitest / tsc / vite — pure TypeScript
tooling with no native code. Installing with `--ignore-scripts` skips the
native gyp builds (`@ronomon/direct-io`, `drivelist`, …) and the Electron
binary download entirely, so those phases pass on nodes that have **no
C/C++ toolchain at all**. Only the package phase compiles native modules
(electron-builder rebuilds them against Electron's headers via
`@electron/rebuild`), so only the package phase does a full scripted install
— and it is gated by `ci/preflight.mjs`, which verifies the toolchain first
and attempts a best-effort auto-install where the platform permits.

### Why electron-builder ^26 (do not downgrade)

electron-builder 25.x ships `@electron/rebuild` 3.6.x → node-gyp 9, whose
bundled gyp imports `distutils` — **removed in Python 3.12** — so packaging
fails on any node with a modern Python (`ModuleNotFoundError: No module named
'distutils'`). Overriding node-gyp alone does not work: node-gyp ≥ 10 moved
to a promise API and `@electron/rebuild` 3.6.x hangs against it.
electron-builder 26 uses `@electron/rebuild` 4.x + node-gyp ≥ 11, which is
Python 3.12/3.13 clean. pnpm settings (patch, build-script allowlist) live in
`pnpm-workspace.yaml` — newer pnpm ignores the `pnpm` field in package.json.

The mac target is **arm64-only** (Apple Silicon), not universal. Several
native deps pulled in by etcher-sdk (lzma-native, drivelist, …) ship prebuilt
`prebuilds/<platform>-<arch>/*.node` binaries that appear byte-identical
across a universal build's two per-arch sub-builds, which makes
`@electron/universal` refuse to merge them ("Detected file … same in both x64
and arm64 builds"). Rather than whitelist every such prebuild, the dmg is
built for arm64 alone — the only supported mac hardware.

### CI node requirements

| Platform | Required on the node | Notes |
|---|---|---|
| linux | **docker** (preferred, best-effort) — the package build runs isolated inside `node:22-bookworm`. If docker is missing OR the container build fails, it automatically falls back to a direct host build, which needs `build-essential` + `python3` on the node. | libfuse is NOT needed to *build* an AppImage, only to run one. `ci/package-linux.mjs --no-docker` forces the direct host build. The container sets `HOME` on the bind-mounted checkout (not `/tmp`) because gyp's Makefiles regenerate via a rule that `execve()`s `gyp_main.py` by its shebang — some hardened docker daemons mount container `/tmp` noexec even when `--tmpfs /tmp:exec` is requested, which otherwise fails with `gyp_main.py: Permission denied` (make Error 126). Keeping the cache on the checkout's filesystem sidesteps that; the direct-build fallback covers any residual case. |
| windows | **Visual Studio 2022 Build Tools** (C++ workload) + **Python 3**. | `ci/preflight.mjs` auto-installs best-effort via `choco` (or `winget`) when present + elevated; otherwise it fails with the exact install commands. Docker on Windows runs *Linux* containers and cannot build Windows Electron targets — a host toolchain is mandatory. |
| mac | **Xcode Command Line Tools** (`xcode-select --install`) + `python3`. | No unattended CLT install exists; preflight fails with instructions until an operator installs it. Signing/notarization additionally need `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. |

## Architecture

- `src/main/` — Electron main process: manifest fetch/normalize, device
  scanning, resumable verified downloads, etcher-sdk flash with verify,
  elevation. All safety rails enforced here.
- `src/preload/` — the narrow contextBridge IPC surface (`window.llamaFlasher`).
- `src/renderer/` — React wizard UI (dark frosted-glass, keyboard accessible).
- `src/shared/` — pure logic (manifest normalization, device safety rails,
  artifact-name mapping) with unit tests under `tests/`.
