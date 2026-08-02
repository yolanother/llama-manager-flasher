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

  it('dedupes concurrent ensure() into a single spawn', async () => {
    let spawns = 0;
    const fakeSpawn = (() => { spawns++; return { kill() {}, exitCode: null, once() {} } as any; }) as any;
    client = new HelperClient(fakeSpawn);
    const p1 = client.ensure('exe', ['helper.js'], undefined, 300).catch(() => {});
    const p2 = client.ensure('exe', ['helper.js'], undefined, 300).catch(() => {});
    await Promise.all([p1, p2]);
    expect(spawns).toBe(1);
  });
});
