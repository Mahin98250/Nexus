import type { HandInput, Landmark } from './types';

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const distance = (a: Landmark, b: Landmark) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export function deriveHandInput(
  landmarks: readonly Landmark[] | undefined,
  timestamp: number,
): HandInput {
  if (!landmarks || landmarks.length < 21) {
    return {
      detected: false,
      x: 0.5,
      y: 0.5,
      pinch: false,
      openness: 0,
      angle: 0,
      timestamp,
    };
  }

  const wrist = landmarks[0];
  const indexMcp = landmarks[5];
  const middleMcp = landmarks[9];
  const pinkyMcp = landmarks[17];
  const palmScale = Math.max(distance(wrist, middleMcp), 0.001);
  const pinchRatio = distance(landmarks[4], landmarks[8]) / palmScale;
  const palmPoints = [0, 5, 9, 13, 17];
  const centerX = palmPoints.reduce((sum, index) => sum + landmarks[index].x, 0) / palmPoints.length;
  const centerY = palmPoints.reduce((sum, index) => sum + landmarks[index].y, 0) / palmPoints.length;
  const fingerSpread = [8, 12, 16, 20]
    .reduce((sum, index) => sum + distance(wrist, landmarks[index]), 0) / 4 / palmScale;

  return {
    detected: true,
    x: clamp(1 - centerX, 0, 1),
    y: clamp(centerY, 0, 1),
    pinch: pinchRatio < 0.38,
    openness: clamp((fingerSpread - 1.0) / 1.55, 0, 1),
    angle: Math.atan2(indexMcp.y - pinkyMcp.y, indexMcp.x - pinkyMcp.x),
    timestamp,
  };
}
