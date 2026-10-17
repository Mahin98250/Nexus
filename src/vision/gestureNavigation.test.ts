import { describe, expect, it } from 'vitest';
import { clampGesturePointer, GestureActivationGate, shouldActivateGestureTarget } from './gestureNavigation';

describe('global gesture navigation helpers', () => {
  it('activates only on the rising edge of a detected pinch', () => {
    expect(shouldActivateGestureTarget(true, true, false)).toBe(true);
    expect(shouldActivateGestureTarget(true, true, true)).toBe(false);
    expect(shouldActivateGestureTarget(true, false, true)).toBe(false);
    expect(shouldActivateGestureTarget(false, true, false)).toBe(false);
  });

  it('requires a tracked release before activating a pinch and only fires once', () => {
    const gate = new GestureActivationGate();
    // Startup with the hand already pinched is deliberately non-activating.
    expect(gate.update(true, true)).toBe(false);
    expect(gate.update(true, true)).toBe(false);
    expect(gate.update(true, false)).toBe(false);
    expect(gate.update(true, true)).toBe(true);
    expect(gate.update(true, true)).toBe(false);
    expect(gate.update(true, false)).toBe(false);
    expect(gate.update(true, true)).toBe(true);
  });

  it('requires release after tracking loss before another click', () => {
    const gate = new GestureActivationGate();
    expect(gate.update(true, false)).toBe(false);
    expect(gate.update(true, true)).toBe(true);
    expect(gate.update(false, false)).toBe(false);
    // Reacquiring with the same held pinch must not cause a second click.
    expect(gate.update(true, true)).toBe(false);
    expect(gate.update(true, true)).toBe(false);
    expect(gate.update(true, false)).toBe(false);
    expect(gate.update(true, true)).toBe(true);
  });

  it('clamps finite pointer coordinates to the viewport', () => {
    expect(clampGesturePointer(-0.2)).toBe(0);
    expect(clampGesturePointer(0.35)).toBe(0.35);
    expect(clampGesturePointer(1.4)).toBe(1);
  });

  it('uses the centre as a safe fallback for invalid coordinates', () => {
    expect(clampGesturePointer(Number.NaN)).toBe(0.5);
    expect(clampGesturePointer(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});
