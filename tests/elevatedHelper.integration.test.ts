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
