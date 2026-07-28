// Llama Manager Flasher — canonical installer artifact names.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Single source of truth for the exact, versionless installer filenames the
// build must emit per OS. The marketing site links these names as stable
// "latest" URLs, so they must never gain a version suffix — the release tag
// and the app's About dialog carry the version instead. The unit tests
// cross-check package.json's electron-builder artifactName templates against
// this mapping, and the ci/package-*.mjs scripts assert the built file exists
// under exactly these names.

/** Build platform identifiers, matching DoubTech CI platform names. */
export type BuildPlatform = 'linux' | 'mac' | 'windows';

/**
 * Exact installer filename emitted into dist-installer/ for each platform.
 * These are load-bearing: the marketing site hard-links them.
 */
export const ARTIFACT_NAMES: Record<BuildPlatform, string> = {
  windows: 'LlamaManagerFlasher-win-x64-portable.exe',
  mac: 'LlamaManagerFlasher-mac-arm64.dmg',
  linux: 'LlamaManagerFlasher-linux-x86_64.AppImage',
};

/**
 * Returns the canonical installer filename for a build platform.
 *
 * @param platform - The DoubTech CI platform identifier.
 * @returns The exact filename the packaging step must produce.
 * @throws {Error} When the platform is not one of linux / mac / windows.
 */
export function artifactNameFor(platform: string): string {
  const name = ARTIFACT_NAMES[platform as BuildPlatform];
  if (!name) {
    throw new Error(`unknown build platform: ${platform}`);
  }
  return name;
}

/**
 * Maps a Node `process.platform` value to a DoubTech CI build platform.
 *
 * @param nodePlatform - The value of `process.platform`.
 * @returns The corresponding build platform identifier.
 * @throws {Error} When the OS is not a supported build platform.
 */
export function buildPlatformFromNode(nodePlatform: string): BuildPlatform {
  switch (nodePlatform) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'windows';
    default:
      throw new Error(`unsupported build OS: ${nodePlatform}`);
  }
}
