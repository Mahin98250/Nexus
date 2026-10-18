import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve('node_modules/@mediapipe/tasks-vision/wasm');
const destination = resolve('public/mediapipe/wasm');

if (!existsSync(source)) {
  throw new Error('MediaPipe WASM assets are missing from node_modules/@mediapipe/tasks-vision/wasm');
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
console.log('Copied MediaPipe WASM runtime into public/mediapipe/wasm');
