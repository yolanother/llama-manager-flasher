// Llama Manager Flasher — CI package phase (Windows).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Builds the app and packages the Windows portable exe into dist-installer/,
// then asserts the artifact exists under EXACTLY the versionless name the
// marketing site hard-links (LlamaManagerFlasher-win-x64-portable.exe).
// Runnable locally (on Windows) with `node ci/package-windows.mjs`.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { run, ensureFullDeps, repoRoot } from './util.mjs';

// electron-builder's production node-module collector shells out to
// powershell.exe; on a CI agent whose (minimal/stale) PATH lacks the Windows
// PowerShell directory this fails with `spawn powershell.exe ENOENT`. Ensure
// the standard PowerShell location is on PATH for the electron-builder child.
if (process.platform === 'win32') {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const psDir = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  const cur = process.env.Path || process.env.PATH || '';
  if (existsSync(path.join(psDir, 'powershell.exe')) && !cur.toLowerCase().includes(psDir.toLowerCase())) {
    process.env.PATH = `${psDir};${cur}`;
    console.log(`[ci] added PowerShell to PATH for electron-builder: ${psDir}`);
  }
}

ensureFullDeps();
run('pnpm build');
run('pnpm exec electron-builder --win --publish never');

const artifact = path.join(repoRoot, 'dist-installer', 'LlamaManagerFlasher-win-x64-portable.exe');
if (!existsSync(artifact)) {
  console.error(`[ci] expected artifact missing: ${artifact}`);
  process.exit(1);
}
console.log(`[ci] packaged ${artifact} (${statSync(artifact).size} bytes)`);
