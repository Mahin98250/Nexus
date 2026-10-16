import type { HandInput, Landmark } from './types';
import { detectAirHandGesture, clamp, distance2D } from './airHandEngine';

export function deriveHandInput(
  landmarks: readonly Landmark[] | undefined,
  timestamp: number,
  previousPinch = false,
  modelCategory: string | null = null,
  modelScore = 0,
): HandInput {
  if (!landmarks || landmarks.length < 21 ||
      !landmarks.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
    return {
      detected: false, x: 0.5, y: 0.5, pinch: false, openness: 0, angle: 0, timestamp, gesture: 'None', confidence: 0,
    };
  }

  const wrist = landmarks[0];
  const indexMcp = landmarks[5];
  const middleMcp = landmarks[9];
  const pinkyMcp = landmarks[17];
  const palmScale = Math.max(distance2D(wrist, middleMcp), 0.001);
  // AirHand maps the cursor from the index fingertip, not the palm center.
  // This puts the interaction point where the user is pointing and removes the
  // large positional offset that made HoloDesk feel inaccurate.
  const indexTip = landmarks[8];
  const fingerSpread = [8, 12, 16, 20]
    .reduce((sum, index) => sum + distance2D(wrist, landmarks[index]), 0) / 4 / palmScale;
  const gesture = detectAirHandGesture(landmarks, previousPinch, modelCategory, modelScore);

  return {
    detected: true,
    x: clamp(1 - indexTip.x, 0, 1),
    y: clamp(indexTip.y, 0, 1),
    // Use AirHand's palm-normalized pinch thresholds (0.28 press / 0.43 release).
    pinch: gesture.gesture === 'Pinch',
    openness: clamp((fingerSpread - 1.0) / 1.55, 0, 1),
    angle: Math.atan2(indexMcp.y - pinkyMcp.y, indexMcp.x - pinkyMcp.x),
    timestamp,
    gesture: gesture.gesture,
    confidence: gesture.confidence ?? 0,
  };
}
