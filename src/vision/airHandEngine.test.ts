import { describe, expect, it } from 'vitest';
import {
  AirHandCursorCalibrator, AirHandCursorSmoother, AirHandGestureStabilizer,
  detectAirHandGesture, mapCalibratedCursor, validateCursorBounds,
} from './airHandEngine';

function hand() {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  points[0] = { x: 0.5, y: 0.8 };
  points[9] = { x: 0.5, y: 0.5 };
  points[4] = { x: 0.5, y: 0.45 };
  points[8] = { x: 0.6, y: 0.45 };
  return points;
}

describe('AirHand gesture and cursor primitives', () => {
  it('rejects malformed landmark data safely', () => {
    expect(detectAirHandGesture(undefined).gesture).toBe('None');
    expect(detectAirHandGesture([{ x: 0, y: 0 }]).gesture).toBe('None');
    const invalid = hand();
    invalid[7] = { x: Number.NaN, y: 0 };
    expect(detectAirHandGesture(invalid).gesture).toBe('None');
  });

  it('uses palm-relative pinch thresholds with press/release hysteresis', () => {
    const points = hand();
    expect(detectAirHandGesture(points, false).gesture).not.toBe('Pinch');
    expect(detectAirHandGesture(points, true).gesture).toBe('Pinch');
    points[8] = { x: 0.52, y: 0.45 };
    expect(detectAirHandGesture(points, false).gesture).toBe('Pinch');
  });

  it('prefers supported model labels only when their confidence gate is met', () => {
    const points = hand();
    expect(detectAirHandGesture(points, false, 'Victory', 0.9).gesture).toBe('Peace');
    expect(detectAirHandGesture(points, false, 'Victory', 0.5).gesture).not.toBe('Peace');
    expect(detectAirHandGesture(points, false, 'Closed_Fist', 0.9).gesture).toBe('Fist');
  });

  it('stabilizes gestures and immediately clears on tracking loss', () => {
    const filter = new AirHandGestureStabilizer(100);
    expect(filter.update('Point', 1000)).toBe('None');
    expect(filter.update('Point', 1100)).toBe('Point');
    expect(filter.update('None', 1101)).toBe('None');
  });

  it('suppresses micro-jitter and follows large cursor movement faster', () => {
    const smooth = new AirHandCursorSmoother(0.18);
    expect(smooth.update(0.5, 0.5, 0)).toEqual({ x: 0.5, y: 0.5 });
    expect(smooth.update(0.5005, 0.5005, 16)).toEqual({ x: 0.5, y: 0.5 });
    const moved = smooth.update(0.9, 0.9, 32);
    expect(moved.x).toBeGreaterThan(0.5);
    expect(moved.x).toBeLessThan(0.9);
  });

  it('rejects narrow calibration and maps valid calibrated bounds', () => {
    const tooNarrow = new AirHandCursorCalibrator();
    for (let i = 0; i < 25; i++) tooNarrow.add(0.45 + i * 0.001, 0.45 + i * 0.001);
    expect(tooNarrow.finish()).toBeNull();

    const calibration = new AirHandCursorCalibrator();
    for (let i = 0; i < 25; i++) calibration.add(0.1 + (i % 5) * 0.18, 0.12 + Math.floor(i / 5) * 0.18);
    const bounds = calibration.finish();
    expect(bounds).not.toBeNull();
    expect(validateCursorBounds(bounds!)).toBe(true);
    expect(mapCalibratedCursor(bounds!.minX, bounds!.minY, bounds)).toEqual({ x: 0, y: 0 });
    expect(mapCalibratedCursor(0.5, 0.5, { minX: 0.5, maxX: 0.5, minY: 0, maxY: 1 })).toBeNull();
  });
});
