import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const modelUrl = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const destination = resolve('public/mediapipe/models/hand_landmarker.task');
const temporary = destination + '.download';
const minimumBytes = 1_000_000;

mkdirSync(dirname(destination), { recursive: true });
rmSync(temporary, { force: true });

let lastError;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    const response = await fetch(modelUrl, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Model download returned HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < minimumBytes) {
      throw new Error(`Downloaded model is unexpectedly small (${bytes.byteLength} bytes)`);
    }
    // MediaPipe task bundles are binary assets; reject HTML/error pages before publishing.
    const prefix = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase();
    if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) {
      throw new Error('Model URL returned HTML instead of a task model');
    }
    writeFileSync(temporary, bytes);
    renameSync(temporary, destination);
    console.log(`Downloaded hand landmark model (${bytes.byteLength} bytes) to public/mediapipe/models/hand_landmarker.task`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    rmSync(temporary, { force: true });
    if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1000));
  }
}
throw new Error(`Unable to bundle the MediaPipe hand landmark model after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
