import { describe, expect, it } from 'vitest';
import { deriveHandInput } from './gestures';
import type { Landmark } from './types';

function createLandmarks(overrides: Record<number, Partial<Landmark>> = {}): Landmark[] {
  const points = Array.from({ length: 21 }, (_, index) => ({
    x: 0.4 + (index % 4) * 0.02,
    y: 0.35 + Math.floor(index / 4) * 0.025,
    z: 0,
  }));
  points[0] = { x: 0.5, y: 0.7, z: 0 };
  points[5] = { x: 0.42, y: 0.43, z: 0 };
  points[9] = { x: 0.5, y: 0.42, z: 0 };
  points[13] = { x: 0.56, y: 0.46, z: 0 };
  points[17] = { x: 0.6, y: 0.5, z: 0 };
  points[4] = { x: 0.51, y: 0.53, z: 0 };
  points[8] = { x: 0.52, y: 0.53, z: 0 };
  for (const [rawIndex, value] of Object.entries(overrides)) {
    const index = Number(rawIndex);
    points[index] = { ...points[index], ...value };
  }
  return points;
}

describe('deriveHandInput', () => {
  it('returns a safe no-hand state for missing or incomplete landmarks', () => {
    expect(deriveHandInput(undefined, 42)).toMatchObject({
      detected: false, pinch: false, x: 0.5, y: 0.5, timestamp: 42,
    });
    expect(deriveHandInput([{ x: 0.2, y: 0.4 }], 7).detected).toBe(false);
  });

  it('mirrors horizontal coordinates to match the selfie preview', () => {
    const input = deriveHandInput(createLandmarks(), 100);
    expect(input.detected).toBe(true);
    expect(input.x).toBeGreaterThan(0);
    expect(input.x).toBeLessThan(1);
    expect(input.timestamp).toBe(100);
  });

  it('identifies a pinch using a palm-relative distance threshold', () => {
    const input = deriveHandInput(createLandmarks({ 4: { x: 0.5, y: 0.52 }, 8: { x: 0.505, y: 0.52 } }), 1);
    expect(input.pinch).toBe(true);
  });

  it('does not classify separated thumb and index fingertips as a pinch', () => {
    const input = deriveHandInput(createLandmarks({ 4: { x: 0.4, y: 0.3 }, 8: { x: 0.62, y: 0.3 } }), 1);
    expect(input.pinch).toBe(false);
  });
  it('uses separate pinch-on and pinch-off thresholds to resist jitter', () => {
    const landmarks = createLandmarks({ 4: { x: 0.4, y: 0.5 }, 8: { x: 0.52, y: 0.5 } });
    expect(deriveHandInput(landmarks, 2, false).pinch).toBe(false);
    expect(deriveHandInput(landmarks, 3, true).pinch).toBe(true);
  });

});
