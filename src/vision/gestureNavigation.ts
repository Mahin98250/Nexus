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

export function clampGesturePointer(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
