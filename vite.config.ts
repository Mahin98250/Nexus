import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Ship the MediaPipe runtime assets with the GitHub Pages build so mobile
// browsers don't have to fetch executable WASM loader scripts from a CDN.
const bundleMediaPipeWasm = {
  name: 'bundle-mediapipe-wasm',
  apply: 'build' as const,
  closeBundle() {
    const source = resolve(projectRoot, 'node_modules/@mediapipe/tasks-vision/wasm');
    const destination = resolve(projectRoot, 'dist/mediapipe/wasm');
    if (!existsSync(source)) {
      throw new Error('MediaPipe WASM assets were not found in node_modules/@mediapipe/tasks-vision/wasm');
    }
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true });
  },
};

export default defineConfig({
  plugins: [react(), bundleMediaPipeWasm],
  server: { host: '0.0.0.0' },
});
