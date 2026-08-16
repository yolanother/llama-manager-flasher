// Llama Manager Flasher — local-image picker presentation tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Verifies the platform-page affordance for flashing an already-downloaded
// image: choosing a file, the interactive pre-write checksum check (when it
// auto-triggers, how each outcome renders, and that a stale in-flight result
// can never mark a changed input valid), and the type guard that keeps the
// local path off the download code path.

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  LocalImagePicker,
  applyLocalShaCheck,
  isLocalImage,
  shouldCheckLocalSha,
} from '../src/renderer/App';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

const noop = {
  onChoose: vi.fn(),
  onShaChange: vi.fn(),
  onClear: vi.fn(),
  onContinue: vi.fn(),
  status: { state: 'idle' } as LocalShaStatus,
};

const selection = { path: '/tmp/appliance.iso', file: 'appliance.iso', size: 2_000_000_000 };

describe('LocalImagePicker', () => {
  it('offers a choose-file action before any file is selected', () => {
    const html = renderToStaticMarkup(createElement(LocalImagePicker, {
      selection: null,
      sha: '',
      busy: false,
      ...noop,
    }));

    expect(html).toContain('Choose a downloaded image');
    expect(html).not.toContain('Continue');
  });

  it('disables the chooser while another selection is in flight', () => {
    const html = renderToStaticMarkup(createElement(LocalImagePicker, {
      selection: null,
      sha: '',
      busy: true,
      ...noop,
    }));

    expect(html).toContain('disabled');
  });

  it('shows the chosen file, an optional checksum field, and continue', () => {
    const html = renderToStaticMarkup(createElement(LocalImagePicker, {
      selection,
      sha: '',
      busy: false,
      ...noop,
    }));

    expect(html).toContain('appliance.iso');
    expect(html).toContain('2.0 GB');
    expect(html).toContain('optional');
    expect(html).toContain('Continue');
    expect(html).toContain('Choose a different file');
  });

  it('says nothing about the checksum while the field is idle', () => {
    const html = renderToStaticMarkup(createElement(LocalImagePicker, {
      selection,
      sha: '',
      busy: false,
      ...noop,
    }));

    expect(html).not.toContain('local-sha-status');
  });

  it('reports hashing progress while the check is running', () => {
    const html = renderToStaticMarkup(createElement(LocalImagePicker, {
      selection,
      sha: DIGEST,
      busy: false,
      ...noop,
      status: { state: 'checking', bytes: 3_000_000_000, total: 15_000_000_000 } as LocalShaStatus,
    }));

    expect(html).toContain('Verifying');
    expect(html).toContain('3.0 GB');
    expect(html).toContain('15.0 GB');
  });

  it('renders a checkmark with an accessible label when the checksum matches', () => {
    const html = renderToStaticMarkup(createElement(LocalImagePicker, {
      selection,
      sha: DIGEST,
      busy: false,
      ...noop,
      status: { state: 'valid' } as LocalShaStatus,
    }));

    // The glyph is decorative — the status text is what carries the meaning.
    expect(html).toContain('✓');
    expect(html).toContain('aria-hidden');
    expect(html).toContain('Checksum matches');
    expect(html).toContain('role="status"');
  });

  it('surfaces the file’s actual digest on a mismatch', () => {
    const html = renderToStaticMarkup(createElement(LocalImagePicker, {
      selection,
      sha: DIGEST,
      busy: false,
      ...noop,
      status: { state: 'mismatch', actual: OTHER_DIGEST } as LocalShaStatus,
    }));

    expect(html).toContain('does not match');
    expect(html).toContain(OTHER_DIGEST);
  });

  it('reports an unreadable file as a read error, not a mismatch', () => {
    const html = renderToStaticMarkup(createElement(LocalImagePicker, {
      selection,
      sha: DIGEST,
      busy: false,
      ...noop,
      status: { state: 'error', message: 'EACCES: permission denied' } as LocalShaStatus,
    }));

    expect(html).toContain('Could not read');
    expect(html).toContain('EACCES: permission denied');
    expect(html).not.toContain('does not match');
  });
});

describe('shouldCheckLocalSha', () => {
  it('triggers as soon as a complete 64-hex digest is present', () => {
    expect(shouldCheckLocalSha('/tmp/a.iso', DIGEST)).toBe(true);
    expect(shouldCheckLocalSha('/tmp/a.iso', `  ${DIGEST.toUpperCase()}  `)).toBe(true);
  });

  it('does not trigger on a partial, over-long, or non-hex value', () => {
    expect(shouldCheckLocalSha('/tmp/a.iso', '')).toBe(false);
    expect(shouldCheckLocalSha('/tmp/a.iso', DIGEST.slice(0, 63))).toBe(false);
    expect(shouldCheckLocalSha('/tmp/a.iso', `${DIGEST}a`)).toBe(false);
    expect(shouldCheckLocalSha('/tmp/a.iso', 'z'.repeat(64))).toBe(false);
  });

  it('does not trigger without a chosen file', () => {
    expect(shouldCheckLocalSha('', DIGEST)).toBe(false);
  });
});

describe('applyLocalShaCheck', () => {
  it('marks a matching file valid', async () => {
    const apply = vi.fn();
    await applyLocalShaCheck(
      async () => ({ ok: true, actual: DIGEST, error: null }),
      () => true,
      apply,
    );
    expect(apply).toHaveBeenCalledWith({ state: 'valid' });
  });

  it('reports the actual digest on a mismatch', async () => {
    const apply = vi.fn();
    await applyLocalShaCheck(
      async () => ({ ok: false, actual: OTHER_DIGEST, error: null }),
      () => true,
      apply,
    );
    expect(apply).toHaveBeenCalledWith({ state: 'mismatch', actual: OTHER_DIGEST });
  });

  it('reports a read failure as an error rather than a mismatch', async () => {
    const apply = vi.fn();
    await applyLocalShaCheck(
      async () => ({ ok: false, actual: '', error: 'EACCES: permission denied' }),
      () => true,
      apply,
    );
    expect(apply).toHaveBeenCalledWith({ state: 'error', message: 'EACCES: permission denied' });
  });

  it('discards a slow result once the input it was started for changed', async () => {
    let settle!: (r: LocalImageCheck) => void;
    let current = true;
    const apply = vi.fn();

    const done = applyLocalShaCheck(
      () => new Promise<LocalImageCheck>((res) => { settle = res; }),
      () => current,
      apply,
    );

    // The user edits the sha (or picks another file) while the hash is running.
    current = false;
    settle({ ok: true, actual: DIGEST, error: null });
    await done;

    expect(apply).not.toHaveBeenCalled();
  });

  it('discards a stale failure too', async () => {
    let fail!: (e: Error) => void;
    let current = true;
    const apply = vi.fn();

    const done = applyLocalShaCheck(
      () => new Promise<LocalImageCheck>((_res, rej) => { fail = rej; }),
      () => current,
      apply,
    );

    current = false;
    fail(new Error('boom'));
    await done;

    expect(apply).not.toHaveBeenCalled();
  });
});

describe('isLocalImage', () => {
  it('is true for a local selection', () => {
    expect(isLocalImage({ kind: 'local', file: 'a.iso', size: 1, path: '/a.iso', sha256: '' })).toBe(true);
  });

  it('is false for null and for a downloaded appliance image', () => {
    expect(isLocalImage(null)).toBe(false);
    expect(isLocalImage({
      platformId: 'amd',
      arch: 'amd64',
      channel: 'stable',
      version: '1.0.0',
      file: 'a.iso',
      url: 'https://example.test/a.iso',
      sha256: 'abc',
      size: 1,
    })).toBe(false);
  });
});
