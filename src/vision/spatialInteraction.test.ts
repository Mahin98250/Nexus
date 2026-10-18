import { describe, expect, it } from 'vitest';
import { SpatialPinchGate } from './spatialInteraction';

describe('SpatialPinchGate', () => {
  it('requires two distinct camera samples before grabbing', () => {
    const gate = new SpatialPinchGate();
    expect(gate.update(true, true, 100, 100)).toBe(false);
    // Re-reading the same camera result on another animation frame is not confirmation.
    expect(gate.update(true, true, 100, 130)).toBe(false);
    expect(gate.update(true, true, 133, 133)).toBe(true);
  });

  it('releases immediately on detected release or tracking loss', () => {
    const gate = new SpatialPinchGate();
    gate.update(true, true, 100, 100);
    expect(gate.update(true, true, 133, 133)).toBe(true);
    expect(gate.update(true, false, 150, 150)).toBe(false);
    expect(gate.update(true, true, 166, 166)).toBe(false);
    expect(gate.update(false, true, 199, 199)).toBe(false);
  });

  it('fails closed for invalid or out-of-order timestamps', () => {
    const gate = new SpatialPinchGate();
    expect(gate.update(true, true, Number.NaN, 100)).toBe(false);
    gate.update(true, true, 200, 200);
    expect(gate.update(true, true, 180, 220)).toBe(false);
    expect(gate.update(true, true, 230, 230)).toBe(false);
  });
});
