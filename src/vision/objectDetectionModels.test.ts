import { describe, expect, it } from 'vitest';
import { EFFICIENTDET_LITE0_MODEL_CANDIDATES } from './objectDetectionModels';

describe('EfficientDet Lite0 model sources', () => {
  it('uses the published official model filename', () => {
    expect(EFFICIENTDET_LITE0_MODEL_CANDIDATES[0].url).toBe(
      'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite',
    );
    expect(EFFICIENTDET_LITE0_MODEL_CANDIDATES[0].url).not.toContain('/1/1.tflite');
  });

  it('provides a pinned alternate source if Google Storage cannot be fetched', () => {
    expect(EFFICIENTDET_LITE0_MODEL_CANDIDATES).toHaveLength(2);
    expect(EFFICIENTDET_LITE0_MODEL_CANDIDATES[1].url).toContain(
      'raw.githubusercontent.com/hugocornellier/object_detection/70eceb44d4fc8c32f7fbca8310d0fae7d0975870/',
    );
    expect(EFFICIENTDET_LITE0_MODEL_CANDIDATES[1].url).toMatch(/efficientdet_lite0\.tflite$/);
  });
});
