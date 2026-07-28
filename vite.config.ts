// Llama Manager Flasher — Vite config for the renderer bundle.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Builds the React renderer into dist/renderer, which the Electron main
// process loads as a BrowserWindow via file:// in production (or the Vite dev
// server in development). base='./' keeps asset paths relative so the file://
// load works without mounting the dist/ root.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 47175,
    strictPort: true,
  },
});
