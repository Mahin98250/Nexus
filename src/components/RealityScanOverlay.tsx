import { useEffect, useRef, useState, type RefObject } from 'react';
import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import { updateObjectTracks, type TrackedObject } from '../vision/objectTracks';

type Props = {
  active: boolean;
  videoRef: RefObject<HTMLVideoElement>;
};

const visionWasm = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
const objectModel = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/1.tflite';

export default function RealityScanOverlay({ active, videoRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState('Waiting for camera');

  useEffect(() => {
    if (!active) {
      setStatus('Waiting for camera');
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      setStatus('Canvas is not available in this browser');
      return;
    }

    let disposed = false;
    let frame = 0;
    let lastInference = 0;
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
          setStatus('Frame skipped — recovering camera feed');
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
        // The webcam preview is mirrored with CSS; flip detector X while keeping labels readable.
        const x = width - (offsetX + (track.x + track.width) * scale);
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
      setStatus('Loading object model…');
      try {
        const vision = await FilesetResolver.forVisionTasks(visionWasm);
        const options = {
          runningMode: 'VIDEO' as const,
          scoreThreshold: 0.42,
          maxResults: 8,
        };
        let loaded: ObjectDetector;
        try {
          loaded = await ObjectDetector.createFromOptions(vision, {
            ...options,
            baseOptions: { modelAssetPath: objectModel, delegate: 'GPU' },
          });
        } catch {
          loaded = await ObjectDetector.createFromOptions(vision, {
            ...options,
            baseOptions: { modelAssetPath: objectModel, delegate: 'CPU' },
          });
        }
        if (disposed) {
          loaded.close();
          return;
        }
        detector = loaded;
        setStatus('Live object detection · processed on-device');
        frame = requestAnimationFrame(drawDetections);
      } catch {
        if (!disposed) setStatus('Detector unavailable. Stop and restart the camera to retry.');
      }
    };

    void initialize();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      detector?.close();
    };
  }, [active, videoRef]);

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
        <span>LOCAL INFERENCE</span>
      </div>
    </div>
  );
}
