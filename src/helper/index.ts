// Llama Manager Flasher — elevated helper entry point.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Runs headless as a full-Electron process (launched with --helper flag).
// Connects back to the launcher's loopback control server, proves it holds the
// shared token, then services scan/flash/ping commands from the device agent.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { scanDevices, flashDevice } from './deviceAgent.js';
import {
  createFramer,
  encodeMessage,
  type HelperCommand,
  type HelperReply,
} from '../shared/helperProtocol.js';

function argValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) {
    throw new Error(`missing required argument ${flag}`);
  }
  return argv[index + 1];
}

export function runHelper(argv: string[]): void {
  const port = Number(argValue(argv, '--port'));
  const token = readFileSync(argValue(argv, '--token-file'), 'utf8').trim();

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
}
