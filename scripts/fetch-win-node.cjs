// Llama Manager Flasher — electron-builder beforePack hook: bundle node.exe.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// The Windows build ships its own Node interpreter so the app has NO external
// runtime dependency: the privileged helper must run on stock Node (Electron's
// bundled Node cannot open raw \\.\PHYSICALDRIVE paths — EIO), and a clean
// Windows box has no Node installed. This hook downloads the PINNED official
// win-x64 node.exe from nodejs.org into build/win-node/, verifies it against
// the SHA-256 digest nodejs.org publishes in SHASUMS256.txt for that exact
// version, and FAILS the build on any mismatch. The binary is never committed
// to git; a previously fetched copy is reused only after it re-verifies.
// electron-builder then copies it to the packaged resources root via the
// win.extraResources entry in package.json. Non-Windows packs are a no-op.

const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

/** Pinned Node release. Bump deliberately — the digest is checked against it. */
const NODE_VERSION = 'v22.23.2';
/** SHASUMS256.txt entry name for the standalone Windows x64 binary. */
const SHASUMS_ENTRY = 'win-x64/node.exe';
/** Official standalone node.exe for the pinned version. */
const NODE_EXE_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
/** Official checksum manifest for the pinned version. */
const SHASUMS_URL = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;
/** Where the binary lands; matches resolveHelperNode's dev-checkout lookup. */
const DEST = path.resolve(__dirname, '..', 'build', 'win-node', 'node.exe');

/**
 * Extracts one file's SHA-256 digest from a SHASUMS256.txt body.
 *
 * Matches the entry name EXACTLY (not as a prefix or substring), so
 * `win-x64/node.exe` can never be satisfied by `win-x64/node.exe.sig` or a
 * differently-scoped path.
 *
 * @param {string} shasums - Full SHASUMS256.txt contents.
 * @param {string} entry - Exact file name to look up.
 * @returns {string} The lowercase hex digest.
 * @throws {Error} When the entry is absent from the manifest.
 */
function digestFor(shasums, entry) {
  for (const line of String(shasums).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2].trim() === entry) return m[1].toLowerCase();
  }
  throw new Error(`no SHA-256 entry for "${entry}" in ${SHASUMS_URL}`);
}

/**
 * Downloads a URL, failing on any non-2xx response.
 *
 * @param {string} url - Absolute URL to fetch.
 * @returns {Promise<Buffer>} The response body.
 * @throws {Error} On a non-OK HTTP status.
 */
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/** @param {Buffer} buf @returns {string} Lowercase hex SHA-256 of buf. */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Ensures a checksum-verified node.exe exists at {@link DEST}.
 *
 * @returns {Promise<void>} Resolves once the verified binary is in place.
 * @throws {Error} When the download fails or the digest does not match.
 */
async function ensureBundledNode() {
  const expected = digestFor(await download(SHASUMS_URL), SHASUMS_ENTRY);

  if (existsSync(DEST)) {
    const have = sha256(readFileSync(DEST));
    if (have === expected) {
      console.log(`[win-node] reusing verified ${NODE_VERSION} node.exe at ${DEST}`);
      return;
    }
    console.log(`[win-node] cached node.exe does not match ${NODE_VERSION} — refetching`);
  }

  console.log(`[win-node] downloading ${NODE_EXE_URL}`);
  const bin = await download(NODE_EXE_URL);
  const actual = sha256(bin);
  if (actual !== expected) {
    throw new Error(
      `[win-node] SHA-256 MISMATCH for ${NODE_EXE_URL}\n  expected ${expected}\n  actual   ${actual}`,
    );
  }
  mkdirSync(path.dirname(DEST), { recursive: true });
  writeFileSync(DEST, bin);
  console.log(`[win-node] verified ${NODE_VERSION} node.exe (${bin.length} bytes) -> ${DEST}`);
}

/**
 * electron-builder beforePack hook entry point.
 *
 * @param {import('electron-builder').BeforePackContext} context - Builder
 *   context; only `electronPlatformName` is used.
 * @returns {Promise<void>} Resolves when the Windows binary is staged or the
 *   pack was skipped as non-Windows.
 */
module.exports = async function fetchWinNodeHook(context) {
  if (context.electronPlatformName !== 'win32') return;
  await ensureBundledNode();
};

module.exports.NODE_VERSION = NODE_VERSION;
module.exports.NODE_EXE_URL = NODE_EXE_URL;
module.exports.SHASUMS_URL = SHASUMS_URL;
module.exports.SHASUMS_ENTRY = SHASUMS_ENTRY;
module.exports.DEST = DEST;
module.exports.digestFor = digestFor;
module.exports.ensureBundledNode = ensureBundledNode;

// `node scripts/fetch-win-node.cjs` stages the binary without packaging.
if (require.main === module) {
  ensureBundledNode().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
