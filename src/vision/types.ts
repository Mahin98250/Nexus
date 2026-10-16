export type HandInput = {
  detected: boolean;
  /** Mirrored normalized X coordinate, from 0 (left) to 1 (right). */
  x: number;
  /** Normalized Y coordinate, from 0 (top) to 1 (bottom). */
  y: number;
  pinch: boolean;
  openness: number;
  angle: number;
  timestamp: number;
};

export type Landmark = {
  x: number;
  y: number;
  z?: number;
};

export type HandInputRef = { current: HandInput };

export const EMPTY_HAND_INPUT: HandInput = {
  detected: false,
  x: 0.5,
  y: 0.5,
  pinch: false,
  openness: 0,
  angle: 0,
  timestamp: 0,
};
