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
  visibility?: number;
  presence?: number;
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

export type BodyInput = {
  detected: boolean;
  /** Mirrored normalized body center, from 0 (left) to 1 (right). */
  x: number;
  /** True when either wrist is raised above its shoulder. */
  attack: boolean;
  /** Approximate jump signal inferred from ankle-to-hip distance. */
  jump: boolean;
  timestamp: number;
};

export type BodyInputRef = { current: BodyInput };

export const EMPTY_BODY_INPUT: BodyInput = {
  detected: false,
  x: 0.5,
  attack: false,
  jump: false,
  timestamp: 0,
};
