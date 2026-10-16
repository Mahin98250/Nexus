import { describe, expect, it } from 'vitest';
import { updateObjectTracks, type DetectionBox } from './objectTracks';

const box = (overrides: Partial<DetectionBox> = {}): DetectionBox => ({
  label: 'person', score: 0.9, x: 100, y: 80, width: 50, height: 80, ...overrides,
});

describe('updateObjectTracks', () => {
  it('assigns an ID to each newly detected object', () => {
    const result = updateObjectTracks([], [
      box(),
      box({ label: 'chair', x: 300, y: 100 }),
    ], 1);

    expect(result.visible.map((track) => track.id)).toEqual([1, 2]);
    expect(result.nextId).toBe(3);
    expect(result.tracks).toHaveLength(2);
  });

  it('keeps the same ID and smooths coordinates across nearby frames', () => {
    const first = updateObjectTracks([], [box()], 1);
    const second = updateObjectTracks(first.tracks, [box({ x: 110, score: 0.94 })], first.nextId);

    expect(second.visible[0].id).toBe(first.visible[0].id);
    expect(second.visible[0].x).toBeCloseTo(106.4);
    expect(second.visible[0].score).toBeCloseTo(0.94);
    expect(second.visible[0].missed).toBe(0);
  });

  it('does not merge different labels into one object ID', () => {
    const first = updateObjectTracks([], [box()], 1);
    const second = updateObjectTracks(first.tracks, [box({ label: 'dog' })], first.nextId);

    expect(second.visible[0].id).not.toBe(first.visible[0].id);
    expect(second.visible[0].label).toBe('dog');
  });

  it('keeps a briefly missed object faintly for two frames, then drops it', () => {
    const first = updateObjectTracks([], [box()], 1);
    const second = updateObjectTracks(first.tracks, [], first.nextId);
    const third = updateObjectTracks(second.tracks, [], second.nextId);
    const fourth = updateObjectTracks(third.tracks, [], third.nextId);

    expect(second.tracks[0].missed).toBe(1);
    expect(third.tracks[0].missed).toBe(2);
    expect(fourth.tracks).toHaveLength(0);
  });

  it('associates the nearest available same-class track when several objects exist', () => {
    const first = updateObjectTracks([], [
      box({ x: 10, y: 10 }),
      box({ x: 250, y: 10 }),
    ], 1);
    const second = updateObjectTracks(first.tracks, [
      box({ x: 257, y: 12 }),
      box({ x: 18, y: 9 }),
    ], first.nextId);

    expect(second.visible[0].id).toBe(first.visible[1].id);
    expect(second.visible[1].id).toBe(first.visible[0].id);
  });
});
