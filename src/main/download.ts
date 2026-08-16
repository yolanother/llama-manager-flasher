// Llama Manager Flasher — resumable, verified image downloader.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Downloads an appliance ISO into the local image cache with: cache-hit skip
// (an already-present file whose SHA-256 matches is reused without touching
// the network), HTTP Range resume across retries (up to 3 attempts, partial
// bytes kept in a .part file), and a mandatory post-download SHA-256 check
// that deletes the file on mismatch so a corrupt image can never be flashed.

import { promises as fs } from 'node:fs';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Progress event emitted while a download / verification is in flight. */
export interface DownloadProgress {
  phase: 'cached' | 'downloading' | 'verifying' | 'retrying';
  bytes: number;
  total: number;
  attempt?: number;
}

/** Maximum number of download attempts before giving up. */
const MAX_ATTEMPTS = 3;

/**
 * Computes the SHA-256 of a file on disk as lowercase hex.
 *
 * Hashing a ~15 GB appliance image takes minutes, so callers that surface the
 * work in a UI may pass `onProgress` to observe real progress. It is invoked
 * once per read-stream chunk with the cumulative byte count — callers that
 * forward those over IPC are responsible for throttling.
 *
 * @param p - Path of the file to hash.
 * @param onProgress - Optional cumulative-bytes-read callback.
 * @returns The lowercase hex digest.
 * @throws When the file cannot be opened or read.
 */
export async function sha256File(p: string, onProgress?: (bytesRead: number) => void): Promise<string> {
  const h = createHash('sha256');
  if (!onProgress) {
    await pipeline(createReadStream(p), h);
    return h.digest('hex');
  }
  // Async iteration rather than a 'data' listener on a piped stream: that would
  // flip the stream into flowing mode and race the pipeline's own reads.
  let read = 0;
  for await (const chunk of createReadStream(p)) {
    h.update(chunk as Buffer);
    read += (chunk as Buffer).length;
    onProgress(read);
  }
  return h.digest('hex');
}

/**
 * Downloads `url` into `cacheDir` as `file`, verifying it against `sha256`.
 *
 * Behavior:
 * - If the final file already exists and its hash matches, returns it
 *   immediately ("cached" phase) without any network traffic.
 * - Otherwise streams into `<file>.part`. On failure, retries up to 3
 *   attempts total, resuming from the .part file's byte offset via an HTTP
 *   Range request when the server honors it (206).
 * - After the stream completes, hashes the file; a mismatch deletes it and
 *   throws so a corrupted download is never left in the cache.
 *
 * @param args.url - Fully qualified artifact URL.
 * @param args.file - Bare filename to store the artifact under.
 * @param args.sha256 - Expected lowercase hex SHA-256 of the artifact.
 * @param args.size - Expected size in bytes when known (used for progress
 *   totals before headers arrive), or null.
 * @param args.cacheDir - Directory the cache lives in (created if missing).
 * @param args.onProgress - Progress callback for UI reporting.
 * @returns Absolute path of the verified image file.
 * @throws {Error} When all attempts fail or the final hash mismatches.
 */
export async function downloadImage(args: {
  url: string;
  file: string;
  sha256: string;
  size: number | null;
  cacheDir: string;
  onProgress: (p: DownloadProgress) => void;
}): Promise<string> {
  await fs.mkdir(args.cacheDir, { recursive: true });
  const dest = path.join(args.cacheDir, args.file);
  const part = `${dest}.part`;

  // Cache hit: verified file already present.
  try {
    const st = await fs.stat(dest);
    if (st.isFile() && st.size > 0) {
      args.onProgress({ phase: 'verifying', bytes: st.size, total: st.size });
      if ((await sha256File(dest)) === args.sha256) {
        args.onProgress({ phase: 'cached', bytes: st.size, total: st.size });
        return dest;
      }
      await fs.unlink(dest); // stale/corrupt cache entry
    }
  } catch {
    /* not cached — download */
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        args.onProgress({ phase: 'retrying', bytes: 0, total: args.size ?? 0, attempt });
      }
      await downloadAttempt(args.url, part, args.size, args.onProgress);
      // Stream finished — verify and promote into place.
      const partSize = (await fs.stat(part)).size;
      args.onProgress({ phase: 'verifying', bytes: partSize, total: partSize });
      const hash = await sha256File(part);
      if (hash !== args.sha256) {
        await fs.unlink(part).catch(() => {});
        throw new Error(`sha256 mismatch: expected ${args.sha256}, got ${hash}`);
      }
      await fs.rename(part, dest);
      return dest;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Hash mismatches are not retried with resume — the bytes are bad.
      if (lastError.message.startsWith('sha256 mismatch')) {
        throw lastError;
      }
    }
  }
  throw new Error(
    `download failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
  );
}

/**
 * Performs a single streaming download attempt into the .part file,
 * resuming from its current size via HTTP Range when possible.
 *
 * @param url - Artifact URL.
 * @param part - Path of the .part staging file.
 * @param expectedSize - Expected total size when known, for progress totals.
 * @param onProgress - Progress callback.
 * @throws {Error} On any HTTP or stream failure (partial bytes are kept).
 */
async function downloadAttempt(
  url: string,
  part: string,
  expectedSize: number | null,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  let offset = 0;
  try {
    offset = (await fs.stat(part)).size;
  } catch {
    offset = 0;
  }

  const headers: Record<string, string> = {};
  if (offset > 0) headers.Range = `bytes=${offset}-`;
  const r = await fetch(url, { headers });
  if (!r.ok || !r.body) {
    throw new Error(`download failed: HTTP ${r.status}`);
  }
  // Server ignored the Range request — start over from byte zero.
  if (offset > 0 && r.status !== 206) {
    offset = 0;
    await fs.unlink(part).catch(() => {});
  }

  const contentLength = Number(r.headers.get('content-length') ?? 0);
  const total = offset + (contentLength || 0) || expectedSize || 0;
  let bytes = offset;
  const ws = createWriteStream(part, offset > 0 ? { flags: 'a' } : {});
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (!ws.write(value)) {
          await new Promise<void>((resolve) => ws.once('drain', resolve));
        }
        bytes += value.length;
        onProgress({ phase: 'downloading', bytes, total });
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      ws.end((err: unknown) => (err ? reject(err as Error) : resolve()));
    });
  }
}
