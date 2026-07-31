// Llama Manager Flasher — local-image picker presentation tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Verifies the platform-page affordance for flashing an already-downloaded
// image: choosing a file, an optional pre-write checksum, and the type guard
// that keeps the local path off the download code path.

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LocalImagePicker, isLocalImage } from '../src/renderer/App';

const noop = {
  onChoose: vi.fn(),
  onShaChange: vi.fn(),
  onClear: vi.fn(),
  onContinue: vi.fn(),
};

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
      selection: { path: '/tmp/appliance.iso', file: 'appliance.iso', size: 2_000_000_000 },
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
