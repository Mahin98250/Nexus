import type { BodyInput, Landmark } from './types';

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function deriveBodyInput(
  landmarks: readonly Landmark[] | undefined,
  timestamp: number,
): BodyInput {
  if (!landmarks || landmarks.length < 29) {
    return { detected: false, x: 0.5, attack: false, jump: false, timestamp };
  }

  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftWrist = landmarks[15];
  const rightWrist = landmarks[16];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  const leftAnkle = landmarks[27];
  const rightAnkle = landmarks[28];
  const confidence = (point: Landmark) => Math.min(point.visibility ?? point.presence ?? 1, 1);
  const visibleCenter = [leftShoulder, rightShoulder, leftHip, rightHip].every((point) => confidence(point) >= 0.35);

  if (!visibleCenter) {
    return { detected: false, x: 0.5, attack: false, jump: false, timestamp };
  }

  const centerX = (leftShoulder.x + rightShoulder.x + leftHip.x + rightHip.x) / 4;
  const hipY = (leftHip.y + rightHip.y) / 2;
  const ankleY = (leftAnkle.y + rightAnkle.y) / 2;

  return {
    detected: true,
    x: clamp(1 - centerX, 0, 1),
    attack: (confidence(leftWrist) >= 0.35 && leftWrist.y < leftShoulder.y - 0.08) ||
      (confidence(rightWrist) >= 0.35 && rightWrist.y < rightShoulder.y - 0.08),
    jump: confidence(leftAnkle) >= 0.4 && confidence(rightAnkle) >= 0.4 && ankleY < hipY + 0.22,
    timestamp,
  };
}
