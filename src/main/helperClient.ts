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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { buildHelperLaunch, type HelperLaunchPlan } from './elevation.js';
import {
  createFramer,
  encodeMessage,
  type HelperCommand,
  type HelperFlashProgress,
  type HelperReply,
} from '../shared/helperProtocol.js';

/** Allows Omit to distribute over union members. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

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
  private onConnect?: () => void;
  private ensuring?: Promise<void>;

  constructor(private readonly spawnFn: typeof nodeSpawn = nodeSpawn) {}

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
  handleConnection(socket: net.Socket): void {
    // Reject racing connections once the real helper is already active.
    if (this.active) { socket.destroy(); return; }

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
          const auth = message as { type?: string; token?: unknown };
          const provided = Buffer.from(String(auth.token ?? ''), 'utf8');
          const expected = Buffer.from(this.token, 'utf8');
          const authOk =
            auth.type === 'auth' &&
            provided.length === expected.length &&
            timingSafeEqual(provided, expected);
          if (authOk) {
            authed = true;
            this.active = socket;
            this.onConnect?.();
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
  request(command: DistributiveOmit<HelperCommand, 'id'>, onProgress?: (p: HelperFlashProgress) => void): Promise<unknown> {
    const socket = this.active;
    if (!socket) return Promise.reject(new Error('helper is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      socket.write(encodeMessage({ id, ...command } as HelperCommand));
    });
  }

  /** Spawns the elevated helper and resolves once it authenticates. */
  ensure(execPath: string, helperScript: string, timeoutMs = 120_000): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    if (this.ensuring) return this.ensuring;
    this.ensuring = (async () => {
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
      try {
        this.child = this.spawnFn(plan.command, plan.args, { detached: false, stdio: 'ignore' });
        await this.waitForConnection(timeoutMs);
      } catch (err) {
        this.child?.kill();
        this.child = null;
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    })().finally(() => { this.ensuring = undefined; });
    return this.ensuring;
  }

  private waitForConnection(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.onConnect = undefined; };
      const timer = setTimeout(() => {
        done();
        reject(new Error('timed out waiting for the elevated helper'));
      }, timeoutMs);
      this.onConnect = () => { done(); resolve(); };
      this.child?.once('exit', () => {
        if (!this.isConnected()) {
          done();
          reject(new Error('administrator access was denied or the helper failed to start'));
        }
      });
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
