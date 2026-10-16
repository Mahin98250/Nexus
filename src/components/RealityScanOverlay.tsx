import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ObjectDetector } from '@mediapipe/tasks-vision';
import { updateObjectTracks, type TrackedObject } from '../vision/objectTracks';

type Props = {
  active: boolean;
  videoRef: RefObject<HTMLVideoElement>;
  onStatusChange: (status: string) => void;
};

// Match AirHand's tested browser runtime and WASM version exactly.
const mediaPipeRuntimeVersion = '0.10.22-rc.20250304';
const mediaPipeBundleCandidates = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${mediaPipeRuntimeVersion}/vision_bundle.mjs`,
  `https://unpkg.com/@mediapipe/tasks-vision@${mediaPipeRuntimeVersion}/vision_bundle.mjs`,
];
const visionWasmCandidates = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${mediaPipeRuntimeVersion}/wasm`,
  `https://unpkg.com/@mediapipe/tasks-vision@${mediaPipeRuntimeVersion}/wasm`,
];
// The official filename is efficientdet_lite0.tflite (not 1.tflite).
// Use a pinned public mirror if Google Storage is blocked on the device's network.
const objectModelCandidates = [
  {
    label: 'Google model',
    url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite',
  },
  {
    label: 'GitHub model mirror',
    url: 'https://raw.githubusercontent.com/hugocornellier/object_detection/70eceb44d4fc8c32f7fbca8310d0fae7d0975870/assets/models/efficientdet_lite0.tflite',
  },
];

export default function RealityScanOverlay({ active, videoRef, onStatusChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const inferenceFpsRef = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState('Waiting for camera');

  useEffect(() => {
    if (!active) {
      setStatus('Waiting for camera');
      onStatusChange('Waiting for camera');
      return;
    }

    const reportStatus = (message: string) => {
      setStatus(message);
      onStatusChange(message);
    };
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      reportStatus('Canvas is not available in this browser');
      return;
    }

    let disposed = false;
    let frame = 0;
    let lastInference = 0;
    let inferenceFrames = 0;
    let inferenceWindowStart = 0;
    let detector: ObjectDetector | null = null;
    let detections: ReturnType<ObjectDetector['detectForVideo']>['detections'] = [];
    let tracks: TrackedObject[] = [];
    let nextTrackId = 1;
    let width = 1;
    let height = 1;
    let pixelRatio = 1;

    const resize = () => {
      width = Math.max(canvas.clientWidth, 1);
      height = Math.max(canvas.clientHeight, 1);
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.6);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const drawDetections = (now: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(drawDetections);
      const video = videoRef.current;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

      if (now - lastInference > 80) {
        try {
          detections = detector?.detectForVideo(video, now).detections ?? [];
          inferenceFrames += 1;
          if (!inferenceWindowStart) inferenceWindowStart = now;
          if (now - inferenceWindowStart >= 1000) {
            if (inferenceFpsRef.current) inferenceFpsRef.current.textContent =
              Math.round(inferenceFrames * 1000 / (now - inferenceWindowStart)) + ' INFER FPS';
            inferenceFrames = 0;
            inferenceWindowStart = now;
          }
          const candidates = detections.flatMap((detection) => {
            const box = detection.boundingBox;
            if (!box) return [];
            const classification = detection.categories[0];
            return [{
              label: classification?.categoryName || 'object',
              score: classification?.score ?? 0,
              x: box.originX,
              y: box.originY,
              width: box.width,
              height: box.height,
            }];
          });
          const update = updateObjectTracks(tracks, candidates, nextTrackId);
          tracks = update.tracks;
          nextTrackId = update.nextId;
          if (countRef.current) {
            countRef.current.textContent = detections.length + (detections.length === 1 ? ' object' : ' objects') + ' · ' + update.visible.length + ' tracks';
          }
        } catch {
          reportStatus('Frame skipped · recovering object detector');
        }
        lastInference = now;
      }

      context.clearRect(0, 0, width, height);
      if (!video.videoWidth || !video.videoHeight) return;
      const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
      const offsetX = (width - video.videoWidth * scale) / 2;
      const offsetY = (height - video.videoHeight * scale) / 2;
      const lineWidth = Math.max(1.5, Math.min(2.5, width / 280));
      const fontSize = Math.max(10, Math.min(14, width / 42));
      context.lineWidth = lineWidth;
      context.font = '600 ' + fontSize + 'px "DM Mono", monospace';
      context.textBaseline = 'middle';

      tracks.forEach((track) => {
        // RealityScan uses the rear camera without mirroring, so model coordinates map directly.
        const x = offsetX + track.x * scale;
        const y = offsetY + track.y * scale;
        const boxWidth = track.width * scale;
        const boxHeight = track.height * scale;
        const faded = track.missed > 0;
        const label = track.label + ' #' + String(track.id).padStart(2, '0') +
          '  ' + Math.round(track.score * 100) + '%';

        context.globalAlpha = faded ? 0.32 : 1;
        context.strokeStyle = '#76e9c7';
        context.shadowColor = 'rgba(118, 233, 199, 0.55)';
        context.shadowBlur = faded ? 2 : 9;
        context.strokeRect(x, y, boxWidth, boxHeight);
        context.shadowBlur = 0;

        const textWidth = context.measureText(label).width;
        const badgeWidth = textWidth + 14;
        const badgeHeight = fontSize + 10;
        const badgeX = Math.max(0, Math.min(width - badgeWidth, x));
        const badgeY = Math.max(0, y - badgeHeight - 4);
        context.fillStyle = 'rgba(9, 22, 25, 0.92)';
        context.fillRect(badgeX, badgeY, badgeWidth, badgeHeight);
        context.fillStyle = '#a8f7dd';
        context.fillText(label, badgeX + 7, badgeY + badgeHeight / 2);
        context.fillStyle = 'rgba(118, 233, 199, 0.06)';
        context.fillRect(x, y, boxWidth, boxHeight);
        context.globalAlpha = 1;
      });
    };

    const initialize = async () => {
      reportStatus('Loading object model…');
      try {
        let mediaPipeModule: typeof import('@mediapipe/tasks-vision') | null = null;
        let bundleError: unknown = null;
        for (const bundleUrl of mediaPipeBundleCandidates) {
          try {
            mediaPipeModule = await import(/* @vite-ignore */ bundleUrl) as typeof import('@mediapipe/tasks-vision');
            break;
          } catch (error) {
            bundleError = error;
          }
        }
        if (!mediaPipeModule) {
          const detail = bundleError instanceof Error ? bundleError.message : String(bundleError ?? 'unknown bundle error');
          throw new Error('MediaPipe browser bundle unavailable: ' + detail.slice(0, 120));
        }
        const FilesetResolver = mediaPipeModule.FilesetResolver;
        let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
        let wasmError: unknown = null;
        for (const wasmRoot of visionWasmCandidates) {
          try {
            vision = await FilesetResolver.forVisionTasks(wasmRoot);
            break;
          } catch (error) {
            wasmError = error;
          }
        }
        if (!vision) {
          const detail = wasmError instanceof Error ? wasmError.message : String(wasmError ?? 'unknown WASM error');
          throw new Error('Matching MediaPipe WASM runtime unavailable: ' + detail.slice(0, 120));
        }
        const options = {
          runningMode: 'VIDEO' as const,
          scoreThreshold: 0.42,
          maxResults: 8,
        };
        let loaded: ObjectDetector | null = null;
        let modelError: unknown = null;
        let loadedModelLabel = '';
        for (const model of objectModelCandidates) {
          for (const delegate of ['GPU', 'CPU'] as const) {
            try {
              loaded = await mediaPipeModule.ObjectDetector.createFromOptions(vision, {
                ...options,
                baseOptions: { modelAssetPath: model.url, delegate },
              });
              loadedModelLabel = model.label;
              break;
            } catch (error) {
              modelError = error;
            }
          }
          if (loaded) break;
        }
        if (!loaded) {
          const detail = modelError instanceof Error ? modelError.message : String(modelError ?? 'unknown model download error');
          throw new Error('Could not download EfficientDet-Lite0 from Google Storage or the GitHub mirror. ' + detail.slice(0, 140));
        }
        if (disposed) {
          loaded.close();
          return;
        }
        detector = loaded;
        reportStatus('Object detection ready · ' + loadedModelLabel);
        frame = requestAnimationFrame(drawDetections);
      } catch (error) {
        if (!disposed) {
          const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 100) : 'Unknown model error';
          reportStatus('Detector unavailable: ' + detail);
        }
      }
    };

    void initialize();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      detector?.close();
    };
  }, [active, videoRef, onStatusChange]);

  if (!active) return null;

  return (
    <div className="realityscan-overlay">
      <canvas ref={canvasRef} className="realityscan-canvas" aria-label="Live object detection overlay" />
      <div className="realityscan-topline">
        <span className="realityscan-mode"><span className="status-dot active" /> VISION / LIVE</span>
        <span className="realityscan-count" ref={countRef}>0 objects</span>
      </div>
      <div className="realityscan-bottomline">
        <span>{status}</span>
        <span ref={inferenceFpsRef}>INFERENCE STARTING</span>
      </div>
    </div>
  );
}
