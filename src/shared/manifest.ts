// Llama Manager Flasher — image-manifest normalization.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Normalizes the two upstream release-description formats served by
// llama-manager.doubtech.ai into a single `ApplianceImage` shape the rest of
// the app consumes: the AMD Ryzen stable channel publishes a coreutils-style
// SHA256SUMS text file next to its ISO, while the NVIDIA DGX Spark
// experimental channel publishes a structured release.json. Both parsers are
// strict — malformed input throws a ManifestError rather than producing a
// half-usable descriptor, because a wrong URL or hash here would flash a bad
// image. Pure module (no Electron / Node APIs) so it is unit-testable.

/** Identifier for a supported appliance hardware platform. */
export type PlatformId = 'amd' | 'nvidia-spark';

/** Release channel maturity for an appliance image. */
export type Channel = 'stable' | 'experimental';

/**
 * A fully normalized, downloadable appliance image descriptor.
 *
 * @property platformId - Which hardware platform the image targets.
 * @property arch - CPU architecture of the image ('amd64' | 'arm64').
 * @property channel - Release maturity; 'experimental' images are surfaced
 *   with warning styling in the UI.
 * @property version - Human-readable appliance version (e.g. "24.04.4").
 * @property file - Bare filename of the image artifact.
 * @property url - Fully qualified download URL for the artifact.
 * @property sha256 - Expected lowercase hex SHA-256 of the artifact.
 * @property size - Artifact size in bytes, or null when the source format
 *   does not carry a size (AMD SHA256SUMS); the downloader then resolves it
 *   via an HTTP HEAD request.
 */
export interface ApplianceImage {
  platformId: PlatformId;
  arch: string;
  channel: Channel;
  version: string;
  file: string;
  url: string;
  sha256: string;
  size: number | null;
}

/** Error thrown when an upstream manifest cannot be safely normalized. */
export class ManifestError extends Error {
  /**
   * @param message - Description of what was malformed in the source data.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Matches one `sha256  filename` line of a coreutils SHA256SUMS file. */
const SUMS_LINE = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/;

/** Extracts the version out of `llama-manager-ubuntu-<ver>-amd64.iso`. */
const AMD_FILE_VERSION = /^llama-manager-ubuntu-(.+)-amd64\.iso$/;

/** Lowercase hex SHA-256 validator. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Joins a base URL and a filename without doubling or dropping the slash.
 *
 * @param baseUrl - Directory-style base URL (with or without trailing slash).
 * @param file - Bare filename to append.
 * @returns The joined URL.
 */
function joinUrl(baseUrl: string, file: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${file}`;
}

/**
 * Parses the AMD Ryzen stable channel's SHA256SUMS text into an
 * {@link ApplianceImage}.
 *
 * The file is expected to contain at least one coreutils-style line whose
 * filename matches `llama-manager-ubuntu-<version>-amd64.iso`; blank lines
 * and `#` comments are tolerated. The first matching ISO line wins. Size is
 * not present in this format and is returned as null.
 *
 * @param text - Raw SHA256SUMS file contents.
 * @param baseUrl - Base download URL the filename is served under.
 * @returns The normalized stable amd64 image descriptor.
 * @throws {ManifestError} When no well-formed llama-manager amd64 ISO line
 *   exists in the input.
 */
export function parseAmdSha256Sums(text: string, baseUrl: string): ApplianceImage {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = SUMS_LINE.exec(trimmed);
    if (!m) continue;
    const [, sha256, file] = m;
    const v = AMD_FILE_VERSION.exec(file);
    if (!v) continue;
    return {
      platformId: 'amd',
      arch: 'amd64',
      channel: 'stable',
      version: v[1],
      file,
      url: joinUrl(baseUrl, file),
      sha256: sha256.toLowerCase(),
      size: null,
    };
  }
  throw new ManifestError(
    'SHA256SUMS contains no well-formed llama-manager-ubuntu-*-amd64.iso entry',
  );
}

/** Shape of one artifact entry in the NVIDIA Spark release.json. */
interface SparkArtifact {
  file: string;
  sha256: string;
  size: number;
}

/**
 * Parses the NVIDIA DGX Spark experimental channel's release.json document
 * into an {@link ApplianceImage}.
 *
 * Expected document shape:
 * `{ platform, arch, channel, version, artifacts: [{ file, sha256, size }] }`.
 * The first `.iso` artifact is selected (first artifact overall if none end
 * in `.iso`). Every field used is validated; anything missing or mistyped
 * throws.
 *
 * @param json - Parsed release.json document (unknown until validated).
 * @param baseUrl - Base download URL the artifact filename is served under.
 * @returns The normalized experimental arm64 image descriptor.
 * @throws {ManifestError} When the document or its selected artifact is
 *   malformed (missing artifacts, bad sha256, non-positive size, etc.).
 */
export function parseSparkRelease(json: unknown, baseUrl: string): ApplianceImage {
  if (typeof json !== 'object' || json === null) {
    throw new ManifestError('release.json is not an object');
  }
  const doc = json as Record<string, unknown>;
  if (!Array.isArray(doc.artifacts) || doc.artifacts.length === 0) {
    throw new ManifestError('release.json has no artifacts');
  }
  const candidates = doc.artifacts as unknown[];
  const chosen =
    candidates.find(
      (a) => typeof a === 'object' && a !== null &&
        typeof (a as SparkArtifact).file === 'string' &&
        (a as SparkArtifact).file.endsWith('.iso'),
    ) ?? candidates[0];
  if (typeof chosen !== 'object' || chosen === null) {
    throw new ManifestError('release.json artifact entry is not an object');
  }
  const art = chosen as Record<string, unknown>;
  if (typeof art.file !== 'string' || art.file.length === 0) {
    throw new ManifestError('release.json artifact is missing a file name');
  }
  if (typeof art.sha256 !== 'string' || !SHA256_HEX.test(art.sha256.toLowerCase())) {
    throw new ManifestError(`release.json artifact "${art.file}" has an invalid sha256`);
  }
  if (typeof art.size !== 'number' || !Number.isFinite(art.size) || art.size <= 0) {
    throw new ManifestError(`release.json artifact "${art.file}" has an invalid size`);
  }
  const version = typeof doc.version === 'string' && doc.version.length > 0
    ? doc.version
    : null;
  if (version === null) {
    throw new ManifestError('release.json is missing a version');
  }
  return {
    platformId: 'nvidia-spark',
    arch: typeof doc.arch === 'string' && doc.arch.length > 0 ? doc.arch : 'arm64',
    channel: doc.channel === 'stable' ? 'stable' : 'experimental',
    version,
    file: art.file,
    url: joinUrl(baseUrl, art.file),
    sha256: (art.sha256 as string).toLowerCase(),
    size: art.size,
  };
}
