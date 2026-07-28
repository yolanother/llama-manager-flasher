// Llama Manager Flasher — Vitest config.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Runs the pure-logic unit tests under tests/ (manifest normalization, device
// safety rails, artifact-name mapping) in a Node environment. CI invokes this
// via `pnpm test:ci`, which adds a JUnit reporter writing
// reports/junit/test.xml for DoubTech CI's testReports aggregation.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
