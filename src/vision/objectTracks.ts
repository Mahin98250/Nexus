export type DetectionBox = {
  label: string;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TrackedObject = DetectionBox & {
  id: number;
  missed: number;
};

export type TrackUpdate = {
  tracks: TrackedObject[];
  visible: TrackedObject[];
  nextId: number;
};

const centerDistance = (a: DetectionBox, b: DetectionBox) =>
  Math.hypot(
    a.x + a.width / 2 - (b.x + b.width / 2),
    a.y + a.height / 2 - (b.y + b.height / 2),
  );

/**
 * Lightweight local association for adjacent detector frames.
 * It smooths a matched box and preserves a missed track for up to two frames.
 * IDs are visual hints, not persistent identity recognition.
 */
export function updateObjectTracks(
  previous: readonly TrackedObject[],
  detections: readonly DetectionBox[],
  nextId: number,
): TrackUpdate {
  const matchedIds = new Set<number>();
  const visible: TrackedObject[] = [];

  for (const detection of detections) {
    const maxDistance = Math.max(42, Math.hypot(detection.width, detection.height) * 0.8);
    let best: TrackedObject | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const track of previous) {
      if (matchedIds.has(track.id) || track.label !== detection.label) continue;
      const distance = centerDistance(track, detection);
      if (distance < maxDistance && distance < bestDistance) {
        best = track;
        bestDistance = distance;
      }
    }

    if (best) {
      matchedIds.add(best.id);
      const blend = 0.64;
      visible.push({
        id: best.id,
        label: detection.label,
        score: detection.score,
        x: best.x * (1 - blend) + detection.x * blend,
        y: best.y * (1 - blend) + detection.y * blend,
        width: best.width * (1 - blend) + detection.width * blend,
        height: best.height * (1 - blend) + detection.height * blend,
        missed: 0,
      });
    } else {
      const created: TrackedObject = { ...detection, id: nextId++, missed: 0 };
      visible.push(created);
      matchedIds.add(created.id);
    }
  }

  const brieflyLost = previous
    .filter((track) => !matchedIds.has(track.id) && track.missed < 2)
    .map((track) => ({ ...track, missed: track.missed + 1, score: track.score * 0.85 }));

  return { tracks: [...visible, ...brieflyLost], visible, nextId };
}
