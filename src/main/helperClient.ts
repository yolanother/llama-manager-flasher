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
  handleConnection(socket: net.Socket): void {
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

  /** Test helper: wire an already-constructed socket as the active connection. */
  acceptForTest(socket: net.Socket): void {
    this.handleConnection(socket);
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
