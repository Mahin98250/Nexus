/**
 * A gesture click is a one-shot action: a stable held pinch must not repeatedly
 * activate buttons until the user releases and pinches again.
 */
export function shouldActivateGestureTarget(
  detected: boolean,
  pinching: boolean,
  wasPinching: boolean,
): boolean {
  return detected && pinching && !wasPinching;
}

/**
 * One-shot click gate for camera-driven pointer input.
 *
 * A new pinch can activate once after a tracked release. If tracking is lost,
 * the gate disarms and requires the hand to be found open before another click.
 * This prevents a held pinch from re-triggering after a brief camera dropout.
 */
export class GestureActivationGate {
  private armed = false;
  private pinching = false;

  reset() {
    this.armed = false;
    this.pinching = false;
  }

  update(detected: boolean, pinching: boolean): boolean {
    if (!detected) {
      this.reset();
      return false;
    }
    if (!pinching) {
      this.armed = true;
      this.pinching = false;
      return false;
    }
    if (!this.armed || this.pinching) {
      this.pinching = true;
      return false;
    }
    this.armed = false;
    this.pinching = true;
    return true;
  }
}

export function clampGesturePointer(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
