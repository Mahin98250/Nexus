import { describe, expect, it } from 'vitest';
import { deriveBodyInput } from './bodyGestures';
import type { Landmark } from './types';

function pose(overrides: Record<number, Partial<Landmark>> = {}): Landmark[] {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  points[11] = { x: 0.4, y: 0.3, z: 0 };
  points[12] = { x: 0.6, y: 0.3, z: 0 };
  points[15] = { x: 0.4, y: 0.5, z: 0 };
  points[16] = { x: 0.6, y: 0.5, z: 0 };
  points[23] = { x: 0.44, y: 0.58, z: 0 };
  points[24] = { x: 0.56, y: 0.58, z: 0 };
  points[27] = { x: 0.44, y: 0.96, z: 0 };
  points[28] = { x: 0.56, y: 0.96, z: 0 };
  for (const [rawIndex, value] of Object.entries(overrides)) {
    const index = Number(rawIndex);
    points[index] = { ...points[index], ...value };
  }
  return points;
}

describe('deriveBodyInput', () => {
  it('returns a safe state when a full pose was not found', () => {
    expect(deriveBodyInput(undefined, 15)).toMatchObject({
      detected: false, attack: false, jump: false, x: 0.5, timestamp: 15,
    });
  });

  it('detects a raised wrist as an attack gesture', () => {
    const input = deriveBodyInput(pose({ 15: { y: 0.1 } }), 20);
    expect(input.detected).toBe(true);
    expect(input.attack).toBe(true);
    expect(input.jump).toBe(false);
  });

  it('detects a jump-like pose and mirrors the body position', () => {
    const input = deriveBodyInput(pose({
      11: { x: 0.2 }, 12: { x: 0.4 }, 23: { x: 0.22, y: 0.4 },
      24: { x: 0.38, y: 0.4 }, 27: { y: 0.5 }, 28: { y: 0.5 },
    }), 30);
    expect(input.x).toBeGreaterThan(0.5);
    expect(input.jump).toBe(true);
  });
});
