# Elevated Helper Process Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all raw-device work (scan + flash) into a long-lived elevated helper process controlled by an always-unprivileged launcher over an authenticated loopback channel, so the launcher window never closes and elevation is granted once per session.

**Architecture:** The Electron main process ("launcher") stays unprivileged for its whole lifetime and no longer imports `etcher-sdk`. It runs a loopback TCP control server, spawns a headless elevated helper (the app binary run via `ELECTRON_RUN_AS_NODE=1`), and drives it with newline-delimited JSON commands. The helper owns `etcher-sdk`, enforces all safety rails, and streams progress/results back.

**Tech Stack:** TypeScript (ESM), Electron 33, `etcher-sdk` 9, Node `net`/`child_process`/`crypto`, Vitest.

## Global Constraints

- Copyright header on every new source file, matching existing files verbatim: `// Llama Manager Flasher — <short description>.` then the standard 3-line license block (see any file under `src/`).
- ESM only. Main/helper/shared compile via `tsconfig.main.json` (`module: ESNext`, `moduleResolution: bundler`, imports use `.js` extensions for local files, e.g. `import { x } from './y.js'`).
- Tests live under `tests/**/*.test.ts` (Vitest `environment: node`); run with `pnpm test`.
- Typecheck must stay clean: `pnpm typecheck` (main + preload + renderer projects). Lint via `noUnusedLocals`/`noUnusedParameters` in tsconfig.
- The launcher process MUST NOT import `etcher-sdk` after this work. Only `src/helper/**` may.
- Safety rails (`driveRejectionReason` from `src/shared/deviceSafety.ts`, re-enumerate-and-match, typed-confirmation match) MUST run in the helper.
- Control channel: `127.0.0.1` only, 256-bit random token, token passed via a temp file (not argv), verified before any command is honored.
- Commit after each task with the message shown in that task's final step.

---

## File Structure

- Create `src/shared/helperProtocol.ts` — message types + pure framing (`encodeMessage`, `createFramer`). No Node deps.
- Create `src/helper/deviceAgent.ts` — `etcher-sdk` scan + flash logic (absorbs `src/main/index.ts` device code; reuses `driveScanner.ts` + `deviceSafety.ts`).
- Create `src/helper/index.ts` — helper entry: read token, connect, authenticate, dispatch commands to `deviceAgent`, stream replies.
- Create `src/main/helperClient.ts` — control server + spawn manager + request/stream API used by main IPC handlers.
- Modify `src/main/elevation.ts` — replace `relaunchElevated` with a pure `buildHelperLaunch` + impure `spawnHelper`; keep/adjust `getElevationStatus`.
- Modify `src/main/index.ts` — `devices:list` / `flash:start` delegate to `helperClient`; drop `etcher-sdk` import + `loadScanner`; replace `elevation:relaunch` with `elevation:ensureHelper`; dispose helper on quit.
- Modify `src/preload/index.cts` + `src/renderer/types.d.ts` — swap `elevation.relaunch` for `elevation.ensureHelper`; extend `elevation.status`.
- Modify `src/renderer/App.tsx` — helper-spawn UX (request-access + retry), flash gating on helper readiness.
- Modify `tsconfig.main.json` — add `src/helper/**/*.ts` to `include`.
- Create `tests/helperProtocol.test.ts`, `tests/helperLaunch.test.ts`, `tests/helperClient.test.ts`, `tests/elevatedHelper.integration.test.ts`.

---

## Task 1: Control-channel protocol (types + framing)

**Files:**
- Create: `src/shared/helperProtocol.ts`
- Test: `tests/helperProtocol.test.ts`

**Interfaces:**
- Produces:
  - `HelperCommand` = `{ id: number; type: 'scan' }` | `{ id: number; type: 'flash'; devicePath: string; imagePath: string; typedConfirmation: string }` | `{ id: number; type: 'cancel' }` | `{ id: number; type: 'ping' }`
  - `HelperFlashProgress` = `{ phase: string; bytesWritten: number; size: number; speed: number; percentage: number; error?: string }`
  - `HelperReply` = `{ id: number; kind: 'progress'; progress: HelperFlashProgress }` | `{ id: number; kind: 'result'; result: unknown }` | `{ id: number; kind: 'error'; error: string }`
  - `AuthMessage` = `{ type: 'auth'; token: string }`
  - `encodeMessage(msg: unknown): string`
  - `createFramer(): { push(chunk: string): unknown[] }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/helperProtocol.test.ts
import { describe, expect, it } from 'vitest';
import { encodeMessage, createFramer } from '../src/shared/helperProtocol';

describe('encodeMessage', () => {
  it('serializes to a single newline-terminated JSON line', () => {
    expect(encodeMessage({ id: 1, type: 'ping' })).toBe('{"id":1,"type":"ping"}\n');
  });
});

describe('createFramer', () => {
  it('emits one object per complete line', () => {
    const framer = createFramer();
    expect(framer.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('buffers a partial line until its newline arrives', () => {
    const framer = createFramer();
    expect(framer.push('{"a":')).toEqual([]);
    expect(framer.push('1}\n')).toEqual([{ a: 1 }]);
  });

  it('ignores empty lines and keeps trailing partial data', () => {
    const framer = createFramer();
    expect(framer.push('{"a":1}\n\n{"b":2}')).toEqual([{ a: 1 }]);
    expect(framer.push('}\n')).toEqual([]); // '{"b":2}}' is invalid → thrown? see below
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/helperProtocol.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/helperProtocol'`.

- [ ] **Step 3: Write minimal implementation**

Replace the third test's last two lines with a valid continuation to avoid asserting on `JSON.parse` throwing (keep the framer strict — malformed JSON throws, which is desired for a trusted channel):

```ts
  it('ignores empty lines between complete messages', () => {
    const framer = createFramer();
    expect(framer.push('{"a":1}\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
```

Then create `src/shared/helperProtocol.ts`:

```ts
// Llama Manager Flasher — helper control-channel protocol (framing + types).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Pure, dependency-free wire format for the launcher <-> elevated-helper
// channel: newline-delimited JSON. The launcher sends HelperCommand; the helper
// replies with HelperReply. The first line the helper sends is AuthMessage.

/** First line the helper sends after connecting; proves it holds the token. */
export interface AuthMessage {
  type: 'auth';
  token: string;
}

/** Commands sent launcher -> helper. `id` correlates replies to a request. */
export type HelperCommand =
  | { id: number; type: 'scan' }
  | { id: number; type: 'flash'; devicePath: string; imagePath: string; typedConfirmation: string }
  | { id: number; type: 'cancel' }
  | { id: number; type: 'ping' };

/** Write/verify progress the helper streams during a flash. */
export interface HelperFlashProgress {
  phase: string;
  bytesWritten: number;
  size: number;
  speed: number;
  percentage: number;
  error?: string;
}

/** Replies sent helper -> launcher, correlated by the originating command id. */
export type HelperReply =
  | { id: number; kind: 'progress'; progress: HelperFlashProgress }
  | { id: number; kind: 'result'; result: unknown }
  | { id: number; kind: 'error'; error: string };

/** Serializes a message as one newline-terminated JSON line. */
export function encodeMessage(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Stateful newline splitter that yields parsed objects as lines complete. */
export function createFramer(): { push(chunk: string): unknown[] } {
  let buffer = '';
  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      return parts.filter((line) => line.length > 0).map((line) => JSON.parse(line));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/helperProtocol.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/helperProtocol.ts tests/helperProtocol.test.ts
git commit -m "feat(helper): add control-channel protocol framing"
```

---

## Task 2: Per-OS helper launch command builder

**Files:**
- Modify: `src/main/elevation.ts`
- Test: `tests/helperLaunch.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `HelperLaunchPlan` = `{ command: string; args: string[]; elevated: boolean; wrapperScript?: { path: string; content: string } }`
  - `buildHelperLaunch(platform: NodeJS.Platform, opts: { execPath: string; helperScript: string; port: number; tokenFile: string; wrapperPath: string }): HelperLaunchPlan`

Rationale for the wrapper on Windows: `Start-Process -Verb RunAs` (ShellExecute) does not reliably copy the caller's environment across the UAC boundary, so `ELECTRON_RUN_AS_NODE` must be set *inside* the elevated context. We write a temp `.cmd` that sets it, then RunAs that `.cmd`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/helperLaunch.test.ts
import { describe, expect, it } from 'vitest';
import { buildHelperLaunch } from '../src/main/elevation';

const opts = {
  execPath: 'C:\\app\\electron.exe',
  helperScript: 'C:\\app\\dist\\helper\\index.js',
  port: 51515,
  tokenFile: 'C:\\tmp\\tok.txt',
  wrapperPath: 'C:\\tmp\\helper.cmd',
};

describe('buildHelperLaunch', () => {
  it('windows: RunAs a wrapper .cmd that sets ELECTRON_RUN_AS_NODE', () => {
    const plan = buildHelperLaunch('win32', opts);
    expect(plan.command).toBe('powershell.exe');
    expect(plan.elevated).toBe(true);
    expect(plan.args.join(' ')).toContain('Start-Process');
    expect(plan.args.join(' ')).toContain('-Verb RunAs');
    expect(plan.wrapperScript?.path).toBe('C:\\tmp\\helper.cmd');
    expect(plan.wrapperScript?.content).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(plan.wrapperScript?.content).toContain('51515');
    expect(plan.wrapperScript?.content).toContain('tok.txt');
  });

  it('linux: pkexec env ELECTRON_RUN_AS_NODE with the helper args', () => {
    const plan = buildHelperLaunch('linux', { ...opts, execPath: '/opt/app/electron', helperScript: '/opt/app/dist/helper/index.js' });
    expect(plan.command).toBe('pkexec');
    expect(plan.elevated).toBe(true);
    expect(plan.args).toEqual([
      'env', 'ELECTRON_RUN_AS_NODE=1',
      '/opt/app/electron', '/opt/app/dist/helper/index.js',
      '--port', '51515', '--token-file', '/c/tmp/tok.txt'.replace('/c/tmp', 'C:\\tmp'), // see note
    ].map(String));
  });

  it('darwin: spawn directly, unprivileged', () => {
    const plan = buildHelperLaunch('darwin', { ...opts, execPath: '/App/electron', helperScript: '/App/dist/helper/index.js', tokenFile: '/tmp/tok.txt' });
    expect(plan.command).toBe('/App/electron');
    expect(plan.elevated).toBe(false);
    expect(plan.args).toEqual(['/App/dist/helper/index.js', '--port', '51515', '--token-file', '/tmp/tok.txt']);
    expect(plan.wrapperScript).toBeUndefined();
  });
});
```

Note: fix the linux test's `tokenFile` to the platform value instead of the cross-substitution hack — use `{ ...opts, execPath: '/opt/app/electron', helperScript: '/opt/app/dist/helper/index.js', tokenFile: '/tmp/tok.txt' }` and expect the args to end with `'--token-file', '/tmp/tok.txt'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/helperLaunch.test.ts`
Expected: FAIL — `buildHelperLaunch is not exported`.

- [ ] **Step 3: Write minimal implementation**

In `src/main/elevation.ts`, add above `relaunchElevated` (which will be removed in Task 6):

```ts
/** A resolved plan for launching the helper, elevated where the OS requires it. */
export interface HelperLaunchPlan {
  command: string;
  args: string[];
  elevated: boolean;
  wrapperScript?: { path: string; content: string };
}

/**
 * Builds the OS-specific command that starts the headless helper as a Node
 * process (Electron run with ELECTRON_RUN_AS_NODE), elevated on Windows/Linux.
 *
 * @param platform - Target platform.
 * @param opts - Absolute paths, the control port, and the token-file path.
 * @returns The command/args to spawn (plus a wrapper script on Windows).
 */
export function buildHelperLaunch(
  platform: NodeJS.Platform,
  opts: { execPath: string; helperScript: string; port: number; tokenFile: string; wrapperPath: string },
): HelperLaunchPlan {
  const helperArgs = [opts.helperScript, '--port', String(opts.port), '--token-file', opts.tokenFile];
  if (platform === 'win32') {
    const content = [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${opts.execPath}" "${opts.helperScript}" --port ${opts.port} --token-file "${opts.tokenFile}"`,
      '',
    ].join('\r\n');
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Start-Process -FilePath '${opts.wrapperPath.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden`,
      ],
      elevated: true,
      wrapperScript: { path: opts.wrapperPath, content },
    };
  }
  if (platform === 'linux') {
    return {
      command: 'pkexec',
      args: ['env', 'ELECTRON_RUN_AS_NODE=1', opts.execPath, ...helperArgs],
      elevated: true,
    };
  }
  // darwin (and any other unix): no up-front elevation; authopen prompts per device.
  return { command: opts.execPath, args: helperArgs, elevated: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/helperLaunch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/elevation.ts tests/helperLaunch.test.ts
git commit -m "feat(helper): add per-OS helper launch command builder"
```

---

## Task 3: Device agent (helper-side scan + flash)

**Files:**
- Create: `src/helper/deviceAgent.ts`
- Test: covered by existing `tests/driveScanner.test.ts` (logic reused) + a source assertion in Task 10.

**Interfaces:**
- Consumes: `scanSafeDrives`, `normalizeDriveCandidate`, `waitForScannerReady`, `ScannerLike`, `DriveScanResult` from `src/main/driveScanner.js`; `driveRejectionReason` from `src/shared/deviceSafety.js`; `getElevationStatus` from `src/main/elevation.js`; `HelperFlashProgress` from `src/shared/helperProtocol.js`.
- Produces:
  - `scanDevices(): Promise<DriveScanResult>`
  - `flashDevice(args: { devicePath: string; imagePath: string; typedConfirmation: string }, onProgress: (p: HelperFlashProgress) => void): Promise<{ ok: boolean }>`

This is a **move** of the `loadScanner`, `devices:list` body, and `flash:start` body out of `src/main/index.ts` into a process-agnostic module. Behavior is unchanged; only the location moves.

- [ ] **Step 1: Create the module**

Create `src/helper/deviceAgent.ts`:

```ts
// Llama Manager Flasher — privileged device agent (scan + flash via etcher-sdk).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Runs ONLY inside the elevated helper process. Owns the sole import of
// etcher-sdk and re-checks every safety rail (removable-only, size cap,
// re-enumerate-and-match) at the privileged boundary before any raw write.

import { driveRejectionReason } from '../shared/deviceSafety.js';
import {
  normalizeDriveCandidate,
  scanSafeDrives,
  waitForScannerReady,
  type DriveScanResult,
  type ScannerLike,
} from '../main/driveScanner.js';
import { getElevationStatus } from '../main/elevation.js';
import type { HelperFlashProgress } from '../shared/helperProtocol.js';

/** Lazily constructs an etcher-sdk Scanner over non-system block devices. */
async function loadScanner() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (await import('etcher-sdk')) as any;
  const adapters = [
    new sdk.scanner.adapters.BlockDeviceAdapter({ includeSystemDrives: () => false }),
  ];
  return new sdk.scanner.Scanner(adapters);
}

/** Enumerates safe removable block devices with diagnostics. */
export async function scanDevices(): Promise<DriveScanResult> {
  const scanner = (await loadScanner()) as ScannerLike;
  return scanSafeDrives(scanner, { elevated: getElevationStatus().elevated });
}

/** Writes and verifies an image to a re-enumerated, safety-checked device. */
export async function flashDevice(
  args: { devicePath: string; imagePath: string; typedConfirmation: string },
  onProgress: (p: HelperFlashProgress) => void,
): Promise<{ ok: boolean }> {
  if (args.typedConfirmation !== args.devicePath) {
    throw new Error('confirmation text does not match the selected device');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (await import('etcher-sdk')) as any;
  const { sourceDestination, multiWrite } = sdk;

  const source: unknown = args.imagePath.endsWith('.xz')
    ? new sourceDestination.XzSource(new sourceDestination.File({ path: args.imagePath }))
    : new sourceDestination.File({ path: args.imagePath });

  const scanner = await loadScanner();
  await waitForScannerReady(scanner as ScannerLike);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target = Array.from(scanner.drives.values() as Iterable<any>)
    .find((d) => d.device === args.devicePath);
  if (!target) {
    scanner.stop();
    throw new Error(`device ${args.devicePath} not found — was it unplugged?`);
  }

  const normalizedTarget = normalizeDriveCandidate(target);
  const rejection = normalizedTarget == null
    ? 'missing device path — cannot safely identify the target'
    : driveRejectionReason(normalizedTarget);
  if (rejection) {
    scanner.stop();
    throw new Error(`refusing to flash ${args.devicePath}: ${rejection}`);
  }

  const writer = new sourceDestination.BlockDevice({
    drive: target, unmountOnSuccess: true, write: true, direct: true,
  });

  const result = await multiWrite.pipeSourceToDestinations({
    source,
    destinations: [writer],
    verify: true,
    trim: false,
    onProgress: (p: { type: string; bytesWritten?: number; size?: number; speed?: number; percentage?: number }) => {
      onProgress({
        phase: p.type,
        bytesWritten: p.bytesWritten ?? 0,
        size: p.size ?? 0,
        speed: p.speed ?? 0,
        percentage: p.percentage ?? 0,
      });
    },
    onFail: (_dest: unknown, err: Error) => {
      onProgress({ phase: 'failed', bytesWritten: 0, size: 0, speed: 0, percentage: 0, error: err.message });
    },
  });
  scanner.stop();
  return { ok: result.failures.size === 0 };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build:main` (this also proves the new file compiles under `tsconfig.main.json` once Task 9 adds it to `include`; if it errors with "not under rootDir/include", proceed — Task 9 fixes the include, so run typecheck again after Task 9). For now run: `pnpm test -- tests/driveScanner.test.ts`
Expected: PASS (existing 5 tests still green — logic unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/helper/deviceAgent.ts
git commit -m "feat(helper): add privileged device agent (scan + flash)"
```

---

## Task 4: Helper entry point (connect, authenticate, dispatch)

**Files:**
- Create: `src/helper/index.ts`
- Test: dispatch logic is exercised via `tests/helperClient.test.ts` (Task 5, end-to-end over a real loopback socket).

**Interfaces:**
- Consumes: `scanDevices`, `flashDevice` from `./deviceAgent.js`; `AuthMessage`, `HelperCommand`, `HelperReply`, `encodeMessage`, `createFramer` from `../shared/helperProtocol.js`.
- Produces: an executable module (no exports required). Reads `--port` and `--token-file` from `process.argv`.

- [ ] **Step 1: Create the module**

Create `src/helper/index.ts`:

```ts
// Llama Manager Flasher — elevated helper entry point.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Runs headless via ELECTRON_RUN_AS_NODE in the elevated process. Connects back
// to the launcher's loopback control server, proves it holds the shared token,
// then services scan/flash/ping commands from the device agent.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { scanDevices, flashDevice } from './deviceAgent.js';
import {
  createFramer,
  encodeMessage,
  type HelperCommand,
  type HelperReply,
} from '../shared/helperProtocol.js';

function argValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    throw new Error(`missing required argument ${flag}`);
  }
  return process.argv[index + 1];
}

const port = Number(argValue('--port'));
const token = readFileSync(argValue('--token-file'), 'utf8').trim();

const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
  socket.write(encodeMessage({ type: 'auth', token }));
});

function reply(msg: HelperReply): void {
  socket.write(encodeMessage(msg));
}

async function handle(command: HelperCommand): Promise<void> {
  try {
    if (command.type === 'ping') {
      reply({ id: command.id, kind: 'result', result: { pong: true } });
    } else if (command.type === 'scan') {
      reply({ id: command.id, kind: 'result', result: await scanDevices() });
    } else if (command.type === 'flash') {
      const result = await flashDevice(command, (progress) =>
        reply({ id: command.id, kind: 'progress', progress }));
      reply({ id: command.id, kind: 'result', result });
    }
    // 'cancel' is a no-op for the MVP; the socket closing aborts the process.
  } catch (error) {
    reply({ id: command.id, kind: 'error', error: error instanceof Error ? error.message : String(error) });
  }
}

const framer = createFramer();
socket.setEncoding('utf8');
socket.on('data', (chunk: string) => {
  for (const message of framer.push(chunk)) {
    void handle(message as HelperCommand);
  }
});
socket.on('close', () => process.exit(0));
socket.on('error', () => process.exit(1));
```

- [ ] **Step 2: Typecheck the file compiles**

Run: `pnpm test -- tests/helperProtocol.test.ts` (sanity that imports resolve for co-located shared module).
Expected: PASS. (Full compile is verified in Task 9 after tsconfig include is updated.)

- [ ] **Step 3: Commit**

```bash
git add src/helper/index.ts
git commit -m "feat(helper): add helper entry with auth + command dispatch"
```

---

## Task 5: Helper client (control server + spawn + request API)

**Files:**
- Create: `src/main/helperClient.ts`
- Test: `tests/helperClient.test.ts`

**Interfaces:**
- Consumes: `buildHelperLaunch`, `HelperLaunchPlan` from `./elevation.js`; `AuthMessage`, `HelperCommand`, `HelperReply`, `HelperFlashProgress`, `encodeMessage`, `createFramer` from `../shared/helperProtocol.js`.
- Produces (a singleton-style module):
  - `class HelperClient` with:
    - `constructor(deps?: { spawn?: typeof import('node:child_process').spawn; launchPlan?: (port: number, tokenFile: string, wrapperPath: string) => HelperLaunchPlan })`
    - `listen(): Promise<number>` — starts the loopback server, returns the port.
    - `attachConnection(socket)` internal.
    - `handleAuthenticatedSocket(socket)` internal.
    - `request(command: Omit<HelperCommand, 'id'>, onProgress?: (p: HelperFlashProgress) => void): Promise<unknown>` — sends a command, resolves with `result`, rejects on `error`.
    - `isConnected(): boolean`
    - `dispose(): void`
  - The class must be testable without elevation by injecting a fake connection: expose `handleConnection(socket: net.Socket)` used by the server's `connection` event, and a test helper `acceptForTest(socket)`.

Design note: the server verifies the first line is `{ type: 'auth', token }` matching the expected token before wiring the socket as the active helper. Tests drive a real `net` client through this path (no elevation needed).

- [ ] **Step 1: Write the failing test**

```ts
// tests/helperClient.test.ts
import net from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';
import { HelperClient } from '../src/main/helperClient';
import { encodeMessage, createFramer } from '../src/shared/helperProtocol';

let client: HelperClient | undefined;
afterEach(() => client?.dispose());

/** Minimal in-test "helper": connects, authenticates, answers ping/scan. */
function fakeHelper(port: number, token: string, answers: Record<string, unknown>): net.Socket {
  const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
    sock.write(encodeMessage({ type: 'auth', token }));
  });
  const framer = createFramer();
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    for (const msg of framer.push(chunk) as Array<{ id: number; type: string }>) {
      sock.write(encodeMessage({ id: msg.id, kind: 'result', result: answers[msg.type] }));
    }
  });
  return sock;
}

describe('HelperClient', () => {
  it('accepts a token-authenticated connection and resolves a request', async () => {
    client = new HelperClient();
    const port = await client.listen();
    const token = client.token;
    const helper = fakeHelper(port, token, { ping: { pong: true }, scan: { drives: [] } });
    // wait for auth to land
    await new Promise((r) => setTimeout(r, 50));
    expect(client.isConnected()).toBe(true);
    await expect(client.request({ type: 'ping' })).resolves.toEqual({ pong: true });
    await expect(client.request({ type: 'scan' })).resolves.toEqual({ drives: [] });
    helper.destroy();
  });

  it('rejects a connection presenting the wrong token', async () => {
    client = new HelperClient();
    const port = await client.listen();
    const bad = fakeHelper(port, 'not-the-token', {});
    await new Promise((r) => setTimeout(r, 50));
    expect(client.isConnected()).toBe(false);
    bad.destroy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/helperClient.test.ts`
Expected: FAIL — `Cannot find module '../src/main/helperClient'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/helperClient.ts`:

```ts
// Llama Manager Flasher — launcher-side helper controller.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Owns a loopback control server, spawns the elevated helper, authenticates the
// single connection by a 256-bit token, and exposes a request/stream API. The
// launcher stays unprivileged; this is its only path to raw-device work.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { buildHelperLaunch, type HelperLaunchPlan } from './elevation.js';
import {
  createFramer,
  type HelperCommand,
  type HelperFlashProgress,
  type HelperReply,
} from '../shared/helperProtocol.js';
import { encodeMessage } from '../shared/helperProtocol.js';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (p: HelperFlashProgress) => void;
}

export class HelperClient {
  readonly token = randomBytes(32).toString('hex');
  private server: net.Server | null = null;
  private active: net.Socket | null = null;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  /** Starts the loopback control server and returns the bound port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  }

  /** Authenticates a new connection by its first line, then wires it active. */
  private handleConnection(socket: net.Socket): void {
    const framer = createFramer();
    let authed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      let messages: unknown[];
      try {
        messages = framer.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const message of messages) {
        if (!authed) {
          const auth = message as { type?: string; token?: string };
          if (auth.type === 'auth' && auth.token === this.token) {
            authed = true;
            this.active = socket;
          } else {
            socket.destroy();
            return;
          }
        } else {
          this.onReply(message as HelperReply);
        }
      }
    });
    socket.on('close', () => {
      if (this.active === socket) this.active = null;
      for (const [, p] of this.pending) p.reject(new Error('helper connection closed'));
      this.pending.clear();
    });
    socket.on('error', () => socket.destroy());
  }

  private onReply(reply: HelperReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    if (reply.kind === 'progress') { pending.onProgress?.(reply.progress); return; }
    this.pending.delete(reply.id);
    if (reply.kind === 'result') pending.resolve(reply.result);
    else pending.reject(new Error(reply.error));
  }

  isConnected(): boolean {
    return this.active != null;
  }

  /** Sends a command and resolves with its result (rejects on helper error). */
  request(command: Omit<HelperCommand, 'id'>, onProgress?: (p: HelperFlashProgress) => void): Promise<unknown> {
    const socket = this.active;
    if (!socket) return Promise.reject(new Error('helper is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      socket.write(encodeMessage({ id, ...command } as HelperCommand));
    });
  }

  /** Spawns the elevated helper and resolves once it authenticates. */
  async ensure(execPath: string, helperScript: string, timeoutMs = 120_000): Promise<void> {
    if (this.isConnected()) return;
    if (!this.server) await this.listen();
    const port = (this.server!.address() as net.AddressInfo).port;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lmf-helper-'));
    const tokenFile = path.join(dir, 'token');
    const wrapperPath = path.join(dir, 'helper.cmd');
    await fs.writeFile(tokenFile, this.token, { mode: 0o600 });
    const plan: HelperLaunchPlan = buildHelperLaunch(process.platform, {
      execPath, helperScript, port, tokenFile, wrapperPath,
    });
    if (plan.wrapperScript) await fs.writeFile(plan.wrapperScript.path, plan.wrapperScript.content);
    this.child = nodeSpawn(plan.command, plan.args, { detached: false, stdio: 'ignore' });
    await this.waitForConnection(timeoutMs);
  }

  private waitForConnection(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.isConnected()) { clearInterval(timer); resolve(); }
        else if (this.child && this.child.exitCode != null) {
          clearInterval(timer);
          reject(new Error('administrator access was denied or the helper failed to start'));
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('timed out waiting for the elevated helper'));
        }
      }, 150);
    });
  }

  dispose(): void {
    this.active?.destroy();
    this.server?.close();
    if (this.child && this.child.exitCode == null) this.child.kill();
    this.active = null;
    this.server = null;
    this.child = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/helperClient.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/helperClient.ts tests/helperClient.test.ts
git commit -m "feat(helper): add launcher-side control server and request API"
```

---

## Task 6: Rewire main IPC to the helper; remove in-process etcher-sdk

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/elevation.ts` (remove `relaunchElevated`, adjust `getElevationStatus`)

**Interfaces:**
- Consumes: `HelperClient` from `./helperClient.js`; `DriveScanResult` from `./driveScanner.js`; `HelperFlashProgress` from `../shared/helperProtocol.js`.
- Produces: unchanged IPC channels `devices:list`, `flash:start`; new `elevation:ensureHelper`; `elevation:status` now returns `{ platform, needsElevation, helperReady, manualHint }`.

- [ ] **Step 1: Resolve the helper script path and construct the client**

In `src/main/index.ts`, remove the `etcher-sdk` `loadScanner` function and the `import ... DownloadProgress` line stays. Add near the top (after `__dirname`):

```ts
import { HelperClient } from './helperClient.js';

/** Absolute path to the compiled helper entry shipped alongside main. */
const HELPER_SCRIPT = path.join(__dirname, '../helper/index.js');
const helper = new HelperClient();
```

Delete the entire `loadScanner` function and the `import` of `waitForScannerReady`/`normalizeDriveCandidate`/`ScannerLike` if now unused (keep `DriveScanResult` type import). Remove `driveRejectionReason` import if unused. Remove `import { downloadImage, ... }`? No — keep download imports; only device imports go.

- [ ] **Step 2: Replace `devices:list` handler**

```ts
ipcMain.handle('devices:list', async (): Promise<DriveScanResult> => {
  await helper.ensure(process.execPath, HELPER_SCRIPT);
  const result = await helper.request({ type: 'scan' }) as DriveScanResult;
  console.info('[device-scan]', JSON.stringify(result.diagnostics));
  return result;
});
```

- [ ] **Step 3: Replace `flash:start` handler**

```ts
ipcMain.handle('flash:start', async (event, args: { devicePath: string; imagePath: string; typedConfirmation: string }) => {
  await helper.ensure(process.execPath, HELPER_SCRIPT);
  return helper.request(
    { type: 'flash', devicePath: args.devicePath, imagePath: args.imagePath, typedConfirmation: args.typedConfirmation },
    (p) => event.sender.send('flash:progress', p),
  );
});
```

- [ ] **Step 4: Replace elevation IPC + dispose on quit**

Replace the `elevation:status` and `elevation:relaunch` handlers with:

```ts
ipcMain.handle('elevation:status', () => {
  const status = getElevationStatus();
  return {
    platform: status.platform,
    needsElevation: status.platform === 'win32' || status.platform === 'linux',
    helperReady: helper.isConnected(),
    manualHint: status.manualHint,
  };
});

ipcMain.handle('elevation:ensureHelper', async () => {
  await helper.ensure(process.execPath, HELPER_SCRIPT);
  return { ready: helper.isConnected() };
});
```

Add before `app.on('window-all-closed', ...)`:

```ts
app.on('will-quit', () => helper.dispose());
```

- [ ] **Step 5: Remove `relaunchElevated`, keep `getElevationStatus`**

In `src/main/elevation.ts`, delete the `relaunchElevated` function and its now-unused imports (`spawn` if unused; keep `spawnSync`). Keep `getElevationStatus` and `appLaunchPath` (the latter may now be unused — delete if so to satisfy `noUnusedLocals`).

- [ ] **Step 6: Verify main no longer references etcher-sdk**

Run: `pnpm exec grep -rn "etcher-sdk" src/main` (PowerShell: `Select-String -Path src/main/*.ts -Pattern etcher-sdk`).
Expected: **no matches** in `src/main`.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (fix any unused-import errors surfaced by the deletions).

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/main/elevation.ts
git commit -m "refactor(main): drive scan/flash through the elevated helper"
```

---

## Task 7: Update preload bridge + renderer types

**Files:**
- Modify: `src/preload/index.cts`
- Modify: `src/renderer/types.d.ts`

**Interfaces:**
- Produces: `elevation.status()` returns `{ platform: string; needsElevation: boolean; helperReady: boolean; manualHint: string | null }`; new `elevation.ensureHelper(): Promise<{ ready: boolean }>`; `elevation.relaunch` removed.

- [ ] **Step 1: Update the preload bridge**

In `src/preload/index.cts`, replace the `ElevationStatus` interface body and the `elevation` block:

```ts
interface ElevationStatus {
  platform: string;
  needsElevation: boolean;
  helperReady: boolean;
  manualHint: string | null;
}
```

```ts
  elevation: {
    status: (): Promise<ElevationStatus> => ipcRenderer.invoke('elevation:status'),
    ensureHelper: (): Promise<{ ready: boolean }> => ipcRenderer.invoke('elevation:ensureHelper'),
  },
```

- [ ] **Step 2: Update renderer types**

In `src/renderer/types.d.ts`, mirror the same `ElevationStatus` shape and the bridge:

```ts
interface ElevationStatus {
  platform: string;
  needsElevation: boolean;
  helperReady: boolean;
  manualHint: string | null;
}
```

```ts
  elevation: {
    status(): Promise<ElevationStatus>;
    ensureHelper(): Promise<{ ready: boolean }>;
  };
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: renderer project will FAIL where `App.tsx` still references `elevation.relaunch`/`elevation.elevated`/`canRelaunch` — that is fixed in Task 8. The preload project must PASS. Confirm preload passes:
Run: `pnpm exec tsc -p tsconfig.preload.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.cts src/renderer/types.d.ts
git commit -m "feat(ipc): expose ensureHelper and helper-readiness status"
```

---

## Task 8: Renderer elevation UX (request access + retry, flash gating)

**Files:**
- Modify: `src/renderer/App.tsx`
- Test: `tests/drivePicker.test.ts` (update `DrivePermissionNotice` expectations)

**Interfaces:**
- Consumes: `elevation.status()`, `elevation.ensureHelper()` from the bridge.
- Produces: updated `DrivePermissionNotice` props `{ elevation: ElevationStatus | null; onGrant: () => void }`.

- [ ] **Step 1: Update the failing component test**

In `tests/drivePicker.test.ts`, replace the two `DrivePermissionNotice` tests with:

```ts
describe('DrivePermissionNotice', () => {
  it('offers to grant administrator access when the helper is not ready', () => {
    const html = renderToStaticMarkup(createElement(DrivePermissionNotice, {
      elevation: { platform: 'win32', needsElevation: true, helperReady: false, manualHint: null },
      onGrant: vi.fn(),
    }));
    expect(html).toContain('Administrator access is required');
    expect(html).toContain('Grant administrator access');
  });

  it('stays hidden once the helper is connected', () => {
    const html = renderToStaticMarkup(createElement(DrivePermissionNotice, {
      elevation: { platform: 'win32', needsElevation: true, helperReady: true, manualHint: null },
      onGrant: vi.fn(),
    }));
    expect(html).toBe('');
  });

  it('stays hidden on macOS where no up-front elevation is needed', () => {
    const html = renderToStaticMarkup(createElement(DrivePermissionNotice, {
      elevation: { platform: 'darwin', needsElevation: false, helperReady: false, manualHint: null },
      onGrant: vi.fn(),
    }));
    expect(html).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- tests/drivePicker.test.ts`
Expected: FAIL (props/shape changed).

- [ ] **Step 3: Update `DrivePermissionNotice`**

Replace the component and its props interface in `src/renderer/App.tsx`:

```tsx
interface DrivePermissionNoticeProps {
  elevation: ElevationStatus | null;
  onGrant: () => void;
}

export function DrivePermissionNotice({ elevation, onGrant }: DrivePermissionNoticeProps): JSX.Element | null {
  if (!elevation || !elevation.needsElevation || elevation.helperReady) return null;
  return (
    <div className="warn-box elev drive-permission" role="status">
      <div>
        <strong>Administrator access is required</strong>
        <p>The flasher runs device writes in a separate elevated helper. Grant access to scan and flash — this window stays open.</p>
      </div>
      <button type="button" className="ghost compact" onClick={onGrant}>Grant administrator access</button>
      {elevation.manualHint && <p className="hint">{elevation.manualHint}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Wire helper readiness into `App`**

In `App`, replace `needsElevation` and the relaunch calls:

```tsx
  const grantAccess = useCallback(async () => {
    try {
      await window.llamaFlasher.elevation.ensureHelper();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
      return;
    }
    void window.llamaFlasher.elevation.status().then(setElevation);
    void refreshDrives();
  }, [refreshDrives]);

  const helperReady = elevation?.helperReady ?? false;
```

Update the drive step to pass `onGrant={() => void grantAccess()}` to `DrivePermissionNotice` (replacing `onRelaunch`). After each `refreshDrives` success, refresh elevation status so `helperReady` updates — add `void window.llamaFlasher.elevation.status().then(setElevation);` at the end of the `try` block in `refreshDrives`.

Update the confirm step: remove the `needsElevation` warn-box block that offered relaunch, and change the flash button's `disabled` to:

```tsx
disabled={!confirmReady || !helperReady}
```

Remove the now-unused `needsElevation` memo/variable and the `elevation.relaunch` calls in `WindowControls`/confirm. The `reset` callback's `void window.llamaFlasher.elevation.status().then(setElevation);` stays.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test -- tests/drivePicker.test.ts` → Expected: PASS.
Run: `pnpm typecheck` → Expected: PASS (all three projects).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx tests/drivePicker.test.ts
git commit -m "feat(ui): grant-access helper flow replacing app relaunch"
```

---

## Task 9: Build wiring (compile the helper)

**Files:**
- Modify: `tsconfig.main.json`

**Interfaces:** none.

- [ ] **Step 1: Add the helper to the main compile**

In `tsconfig.main.json`, change `include` to:

```json
  "include": ["src/main/**/*.ts", "src/helper/**/*.ts", "src/shared/**/*.ts"]
```

- [ ] **Step 2: Full build**

Run: `pnpm build`
Expected: PASS. Confirm `dist/helper/index.js` and `dist/helper/deviceAgent.js` exist:
Run (PowerShell): `Get-ChildItem dist/helper`
Expected: both files present.

- [ ] **Step 3: Full test + typecheck**

Run: `pnpm test`
Expected: PASS (all suites).
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tsconfig.main.json
git commit -m "build: compile the elevated helper into dist"
```

---

## Task 10: Integration contract test

**Files:**
- Create: `tests/elevatedHelper.integration.test.ts`

**Interfaces:** none (source-level assertions).

- [ ] **Step 1: Write the test**

```ts
// tests/elevatedHelper.integration.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (file: string): string => readFileSync(path.join(root, file), 'utf8');

describe('elevated helper integration', () => {
  it('keeps etcher-sdk out of the launcher and in the helper', () => {
    expect(source('src/main/index.ts')).not.toContain('etcher-sdk');
    expect(source('src/helper/deviceAgent.ts')).toContain('etcher-sdk');
  });

  it('authenticates the loopback channel with a token before commands', () => {
    const client = source('src/main/helperClient.ts');
    expect(client).toContain("'127.0.0.1'");
    expect(client).toContain('randomBytes(32)');
    expect(client).toContain("auth.token === this.token");
    const helper = source('src/helper/index.ts');
    expect(helper).toContain("type: 'auth'");
    expect(helper).toContain('--token-file');
  });

  it('spawns the helper instead of relaunching the app', () => {
    expect(source('src/main/index.ts')).toContain("ipcMain.handle('elevation:ensureHelper'");
    expect(source('src/main/index.ts')).not.toContain('elevation:relaunch');
    expect(source('src/main/elevation.ts')).not.toContain('relaunchElevated');
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test -- tests/elevatedHelper.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/elevatedHelper.integration.test.ts
git commit -m "test(helper): lock the process split and token-gated channel"
```

---

## Task 11: Manual elevation verification (cannot be unit-tested)

**Files:** none.

The UAC/polkit spawn + cross-integrity socket cannot run in CI. Verify by hand on Windows:

- [ ] **Step 1: Build and launch**

Run: `pnpm build; pnpm start`

- [ ] **Step 2: Trigger the helper**

Choose AMD → **Choose the target drive**. Expected: a **single UAC prompt** appears; the launcher window **stays open**. Approve it.

- [ ] **Step 3: Confirm scanning works through the helper**

Expected: the removable-drive list populates (the scan ran in the elevated helper). The "Grant administrator access" notice is gone.

- [ ] **Step 4: Confirm the launcher never closed and flashing runs**

Insert a spare USB stick, complete the typed confirmation, and start a flash. Expected: write + verify progress streams; the launcher window is the same one you started with (no relaunch). If the UAC prompt is dismissed instead, expect the "Grant administrator access" notice with a working retry.

- [ ] **Step 5: If any elevation mechanic needed adjustment**

If the Windows wrapper `.cmd` / `ELECTRON_RUN_AS_NODE` path needed changes to connect, record the fix as an orch learning on `usb-microsd-image-flasher` (the elevated-helper pattern learning already exists — update it):
Run: `orch features learnings list usb-microsd-image-flasher --json`

---

## Self-Review

**Spec coverage:**
- Process split (launcher unprivileged, helper owns etcher-sdk) → Tasks 3, 6, 10. ✓
- Loopback-TCP + user-ACL token trust model → Tasks 1, 5 (server), 5 `ensure` (token file `mode 0o600`), 10. ✓
- Protocol (scan/flash/cancel/ping; progress/result/error) → Task 1, used in 4/5/6. ✓
- Per-OS elevation (Win RunAs wrapper, Linux pkexec, macOS unprivileged) → Task 2. ✓
- Persistent, lazy-on-drive-step spawn; respawn; kill on quit → Task 5 (`ensure`, `dispose`), Task 6 (`devices:list` triggers ensure, `will-quit` disposes). ✓
- UX: remove relaunch, "Requesting/Grant access" + retry, unchanged renderer IPC surface → Tasks 6, 7, 8. ✓
- Safety rails in helper → Task 3 (`flashDevice` re-checks). ✓
- Error handling (helper crash, denied elevation) → Task 5 (`waitForConnection` rejects on child exit; `close` rejects pending), Task 8 (retry). ✓
- Testing (unit framing/dispatch/handshake/spawn-builder; integration source) → Tasks 1, 2, 5, 10; manual 11. ✓
- Packaging (`asarUnpack` native, ship dist helper) → already configured; Task 9 compiles helper into `dist/**`. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The only intentionally-not-unit-tested area (elevated spawn) is covered by the manual Task 11.

**Type consistency:** `HelperCommand`/`HelperReply`/`HelperFlashProgress` defined in Task 1 and used identically in Tasks 4/5/6. `HelperClient.request(command, onProgress)` signature consistent across Tasks 5 and 6. `ElevationStatus` shape identical in Tasks 6/7/8. `buildHelperLaunch` signature identical in Tasks 2 and 5.

**Known risk:** The Windows `Start-Process -Verb RunAs` + wrapper-`.cmd` env approach is the one piece that can't be CI-verified; Task 11 validates it and routes any fix to the existing orch learning.
