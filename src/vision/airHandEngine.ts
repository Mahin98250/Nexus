import type { Landmark } from './types';

export type AirHandGesture =
  | 'None' | 'Pinch' | 'Point' | 'Peace' | 'ThumbsUp' | 'OpenPalm' | 'Fist' | 'Unclear';

export type GestureResult = {
  gesture: AirHandGesture;
  fingers: { index: boolean; middle: boolean; ring: boolean; pinky: boolean } | null;
  pinchRatio: number;
  palmScale: number;
  thumbExtended?: boolean;
  source?: 'geometry' | 'model';
  confidence?: number;
};

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const distance2D = (a: Pick<Landmark, 'x' | 'y'>, b: Pick<Landmark, 'x' | 'y'>) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export function angleDegrees(a: Landmark, vertex: Landmark, c: Landmark): number {
  const ax = a.x - vertex.x, ay = a.y - vertex.y;
  const cx = c.x - vertex.x, cy = c.y - vertex.y;
  const denominator = Math.hypot(ax, ay) * Math.hypot(cx, cy);
  if (!denominator) return 0;
  return Math.acos(clamp((ax * cx + ay * cy) / denominator, -1, 1)) * 180 / Math.PI;
}

function validLandmarks(points: readonly Landmark[] | undefined): points is readonly Landmark[] {
  return Boolean(points && points.length >= 21 &&
    points.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)));
}

function fingerExtended(points: readonly Landmark[], mcp: number, pip: number, tip: number) {
  const jointAngle = angleDegrees(points[mcp], points[pip], points[tip]);
  const wristToPip = distance2D(points[0], points[pip]);
  const wristToTip = distance2D(points[0], points[tip]);
  return jointAngle >= 145 && wristToTip >= wristToPip * 1.045;
}

function thumbExtended(points: readonly Landmark[], palmScale: number) {
  return angleDegrees(points[2], points[3], points[4]) >= 118 &&
    distance2D(points[4], points[5]) / palmScale >= 0.48;
}

const modelMapping: Record<string, AirHandGesture> = {
  Pointing_Up: 'Point', Victory: 'Peace', Thumb_Up: 'ThumbsUp',
  Open_Palm: 'OpenPalm', Closed_Fist: 'Fist',
};
const modelThresholds: Record<string, number> = {
  Pointing_Up: 0.58, Victory: 0.70, Thumb_Up: 0.66, Open_Palm: 0.58, Closed_Fist: 0.62,
};

/** AirHand's normalized geometry recognizer with classifier confidence gates and pinch hysteresis. */
export function detectAirHandGesture(
  points: readonly Landmark[] | undefined,
  previousPinch = false,
  modelCategory: string | null = null,
  modelScore = 0,
): GestureResult {
  if (!validLandmarks(points)) {
    return { gesture: 'None', fingers: null, pinchRatio: Infinity, palmScale: 0 };
  }
  const palmScale = Math.max(distance2D(points[0], points[9]), 0.0001);
  const fingers = {
    index: fingerExtended(points, 5, 6, 8),
    middle: fingerExtended(points, 9, 10, 12),
    ring: fingerExtended(points, 13, 14, 16),
    pinky: fingerExtended(points, 17, 18, 20),
  };
  const isThumbExtended = thumbExtended(points, palmScale);
  const pinchRatio = distance2D(points[4], points[8]) / palmScale;
  if (pinchRatio < (previousPinch ? 0.43 : 0.28)) {
    const strength = clamp((0.43 - pinchRatio) / (0.43 - 0.18), 0, 1);
    return {
      gesture: 'Pinch', fingers, pinchRatio, palmScale, thumbExtended: isThumbExtended,
      source: 'geometry', confidence: Math.round((0.55 + strength * 0.45) * 100) / 100,
    };
  }
  const required = modelCategory ? modelThresholds[modelCategory] ?? 1 : 1;
  if (modelCategory && modelMapping[modelCategory] && modelScore >= required) {
    return {
      gesture: modelMapping[modelCategory], fingers, pinchRatio, palmScale,
      thumbExtended: isThumbExtended, source: 'model', confidence: modelScore,
    };
  }
  const { index, middle, ring, pinky } = fingers;
  const extendedCount = [index, middle, ring, pinky].filter(Boolean).length;
  const thumbRaised = points[4].y < points[3].y - 0.015 && points[4].y < points[0].y - 0.025;
  if (isThumbExtended && thumbRaised && extendedCount === 0)
    return { gesture: 'ThumbsUp', fingers, pinchRatio, palmScale, thumbExtended: isThumbExtended };
  if (index && middle && !ring && !pinky)
    return { gesture: 'Peace', fingers, pinchRatio, palmScale, thumbExtended: isThumbExtended };
  if (index && !middle && !ring && !pinky)
    return { gesture: 'Point', fingers, pinchRatio, palmScale, thumbExtended: isThumbExtended };
  if (index && middle && ring && pinky && isThumbExtended)
    return { gesture: 'OpenPalm', fingers, pinchRatio, palmScale, thumbExtended: isThumbExtended };
  if (!index && !middle && !ring && !pinky && !isThumbExtended)
    return { gesture: 'Fist', fingers, pinchRatio, palmScale, thumbExtended: isThumbExtended };
  return { gesture: 'Unclear', fingers, pinchRatio, palmScale, thumbExtended: isThumbExtended };
}

/** Debounces pose changes, while clearing immediately when tracking is lost. */
export class AirHandGestureStabilizer {
  private stable: AirHandGesture = 'None';
  private candidate: AirHandGesture = 'None';
  private candidateSince = 0;
  private stableSince = 0;
  constructor(private readonly holdMs = 110) {}

  reset() {
    this.stable = 'None'; this.candidate = 'None'; this.candidateSince = 0; this.stableSince = 0;
  }
  update(next: AirHandGesture | null | undefined, now = performance.now()): AirHandGesture {
    if (!next || next === 'None') { this.reset(); return this.stable; }
    if (next !== this.candidate) { this.candidate = next; this.candidateSince = now; return this.stable; }
    if (next !== this.stable && now - this.candidateSince >= this.holdMs) {
      this.stable = next; this.stableSince = now;
    }
    return this.stable;
  }
  getStatus(now = performance.now()) {
    return {
      stable: this.stable !== 'None' && this.candidate === this.stable,
      candidate: this.candidate,
      durationMs: Math.max(0, now - (this.stableSince || this.candidateSince)),
    };
  }
}

/** Adaptive, frame-rate-aware low-pass cursor smoothing copied from AirHand's browser engine. */
export class AirHandCursorSmoother {
  private x = 0.5;
  private y = 0.5;
  private initialized = false;
  private lastAt = 0;
  constructor(private readonly alpha = 0.30) {}
  reset(x = 0.5, y = 0.5) {
    this.x = clamp(x, 0, 1); this.y = clamp(y, 0, 1); this.initialized = true;
  }
  update(x: number, y: number, now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: this.x, y: this.y };
    x = clamp(x, 0, 1); y = clamp(y, 0, 1);
    if (!this.initialized) { this.reset(x, y); this.lastAt = now; return { x: this.x, y: this.y }; }
    const elapsed = Math.max(1, Math.min(100, now - (this.lastAt || now - 16)));
    this.lastAt = now;
    const delta = Math.hypot(x - this.x, y - this.y);
    if (delta <= 0.00045) return { x: this.x, y: this.y };
    const speed = delta / elapsed * 1000;
    const targetAlpha = speed > 1.8 || delta > 0.16 ? 0.86 : speed > 0.65 || delta > 0.055 ? 0.58 : this.alpha;
    const factor = 1 - Math.pow(1 - clamp(targetAlpha, 0.08, 0.78), elapsed / 16.67);
    this.x += (x - this.x) * factor; this.y += (y - this.y) * factor;
    return { x: this.x, y: this.y };
  }
}

/** Validates and maps a learned comfortable motion range; bounds remain caller-owned/local. */
export type AirHandCursorBounds = { minX: number; maxX: number; minY: number; maxY: number };
export function validateCursorBounds(bounds: AirHandCursorBounds): boolean {
  return [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every(Number.isFinite) &&
    bounds.minX >= 0 && bounds.maxX <= 1 && bounds.minY >= 0 && bounds.maxY <= 1 &&
    bounds.maxX > bounds.minX && bounds.maxY > bounds.minY;
}
export function mapCalibratedCursor(x: number, y: number, bounds: AirHandCursorBounds) {
  if (!validateCursorBounds(bounds) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: clamp((x - bounds.minX) / (bounds.maxX - bounds.minX), 0, 1),
    y: clamp((y - bounds.minY) / (bounds.maxY - bounds.minY), 0, 1),
  };
}

export class AirHandCursorCalibrator {
  private samples = 0;
  private minX = 1; private maxX = 0; private minY = 1; private maxY = 0;
  constructor(private readonly minSamples = 20, private readonly minAxisSpan = 0.18, private readonly margin = 0.04) {}
  add(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return;
    this.minX = Math.min(this.minX, x); this.maxX = Math.max(this.maxX, x);
    this.minY = Math.min(this.minY, y); this.maxY = Math.max(this.maxY, y); this.samples++;
  }
  finish(): AirHandCursorBounds | null {
    if (this.samples < this.minSamples || this.maxX - this.minX < this.minAxisSpan ||
        this.maxY - this.minY < this.minAxisSpan) return null;
    const bounds = {
      minX: clamp(this.minX - this.margin, 0, 1), maxX: clamp(this.maxX + this.margin, 0, 1),
      minY: clamp(this.minY - this.margin, 0, 1), maxY: clamp(this.maxY + this.margin, 0, 1),
    };
    return validateCursorBounds(bounds) ? bounds : null;
  }
  sampleCount() { return this.samples; }
}
