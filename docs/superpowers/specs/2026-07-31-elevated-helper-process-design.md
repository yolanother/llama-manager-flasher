# Elevated helper process — design

Date: 2026-07-31

## Problem

Raw block-device writes need administrator/root rights. Today the app elevates
by **relaunching the whole application** (`elevation:relaunch` →
`Start-Process -Verb RunAs` / `pkexec`) and quitting the current instance. This:

- **closes the launcher** (the window the user was using disappears), and
- **fails in development**, where `process.execPath` is the bare
  `electron.exe` in `node_modules` — RunAs launches it with no app-directory
  argument, so no app loads and the non-elevated instance has already quit.

## Goal

A separate, long-lived **elevated helper process** that performs all raw-device
work (scanning **and** flashing), controlled by an always-unprivileged launcher
over an authenticated local IPC channel. The launcher window never closes; the
user grants elevation once per session.

## Decisions (from brainstorming)

- Helper owns **both** scanning and flashing — the single privileged
  "flasher/scanner process." The same privileged scanner also feeds the
  re-enumerate-and-match performed at write time.
- Helper is **persistent**, spawned lazily when the user reaches the drive step
  (one UAC/polkit prompt per session, reused for rescans and the write).
- The launcher stays **unprivileged for its entire lifetime**;
  `elevation:relaunch` is removed.

## 1. Process split

**Launcher (main, always unprivileged)**
- Window/UI, manifest fetch, image download + cache, local-image
  `choose`/`verifyLocal`, elevation orchestration, and the control server.
- **No longer imports `etcher-sdk`** — that native dependency moves entirely
  into the helper. The launcher can never touch raw devices directly.

**Helper (headless, elevated)**
- Loads `etcher-sdk`; performs `scanSafeDrives` and write+verify with
  re-enumerate-and-match.
- **All safety rails live here** (removable-only, 2 TiB cap, typed-confirmation
  match, device re-enumeration) — the helper is the privileged trust boundary.
- Runs on the app's own binary via `ELECTRON_RUN_AS_NODE=1` (no extra runtime
  shipped).

## 2. Control channel + security

A privileged raw-disk writer must obey **only** the genuine launcher, or it is a
local privilege-escalation hole. Trust model:

- Launcher opens a **loopback TCP server on `127.0.0.1:0`** (OS-assigned port),
  generates a 256-bit random token, and writes it to a temp file with a
  **user-only ACL** (avoids exposing the token in process-listing args).
- Launcher spawns the helper elevated with `--port <n>` and the token-file path.
- Helper reads the token, connects to `127.0.0.1:<n>`, and sends the token as
  the first line. The launcher verifies it; a mismatch drops the connection.
  All subsequent commands flow over this one authenticated socket.

Threat analysis:
- The launcher owns the listening port (created before spawn), so no other
  process can pre-bind it; the helper connects out to it.
- A rogue local process can see the port but not the 256-bit token, so it cannot
  impersonate the helper to the launcher, and it cannot command the elevated
  helper (the helper only acts on its one authenticated connection to the
  launcher).

**Protocol:** newline-delimited JSON, request/response plus streamed events.
- Down (launcher → helper): `scan`, `flash`, `cancel`, `ping`.
- Up (helper → launcher): `scan-progress`, `flash-progress`, `result`, `error`.
- Framing (encode/decode) and command dispatch are pure functions, unit-tested.

## 3. Elevation & lifecycle per OS

- **Windows:** `Start-Process -Verb RunAs` (UAC) on `electron.exe` run as node.
- **Linux:** `pkexec` the headless helper (one polkit prompt).
- **macOS:** helper spawns **unprivileged** (no prompt); `etcher-sdk` uses
  `authopen` per-device at write time, as today.

Lifecycle: spawned lazily on drive-step entry, kept alive for the session,
killed on app quit, and **respawned** (re-prompt) if it dies.

## 4. UX change

`elevation:relaunch` is removed. On the drive step the main process ensures the
helper is up: the renderer shows "Requesting administrator access…", then the
live drive list. If the prompt is dismissed or fails, the existing
`DrivePermissionNotice` becomes a **"Grant administrator access / Retry"**
button that re-spawns the helper — the launcher stays open throughout.

The renderer ↔ main IPC surface (`devices.list`, `flash.start`,
`flash.onProgress`) is **unchanged**; main forwards these to the helper and
relays progress events back to the renderer as it does today.

## 5. New / changed modules

- `src/helper/index.ts` — entry: connect, authenticate, dispatch commands.
- `src/helper/deviceAgent.ts` — scan + flash via `etcher-sdk` (absorbs today's
  `src/main/index.ts` device code and reuses `driveScanner.ts`).
- `src/shared/helperProtocol.ts` — message types + framing.
- `src/main/helperClient.ts` — spawn + control server + request/stream API.
- `src/main/elevation.ts` — extended with per-OS *spawn-elevated-helper*
  (replacing `relaunchElevated`).
- `src/main/index.ts` — `devices:list` / `flash:start` handlers delegate to
  `helperClient` instead of loading `etcher-sdk`.
- `tsconfig.main.json` — `include` grows to compile `src/helper/**`.
- Packaging: ensure the helper script ships in `dist` and `etcher-sdk` native
  modules remain `asarUnpack`ed so the `ELECTRON_RUN_AS_NODE` helper can load
  them.

## 6. Error handling

- Helper crash mid-flash → socket close / child-exit detected → flash error
  surfaced to the renderer, retry offered (respawn).
- UAC / polkit denied → spawn rejects → "administrator access was denied,"
  retry offered.
- Scanner-ready timeout still enforced inside the helper.

## 7. Testing

- **Unit:** protocol framing/dispatch, token handshake, per-OS
  spawn-command construction, and the safety re-check in the helper.
- **Integration (source-level):** main no longer imports `etcher-sdk`; the
  helper entry exists; the channel is loopback + token-gated.
- Existing `driveScanner` / `deviceSafety` tests continue to pass — device
  logic moves processes but is not rewritten.

## Out of scope

- No auto-updater changes. No change to the download/verify pipeline. No change
  to the manifest formats or the renderer wizard flow beyond the elevation
  notice wording.
