import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Camera, Check, ChevronRight, CircleHelp, Command,
  Hand, Layers3, Maximize2, Monitor, Move3D, Play, ScanLine,
  Settings2, ShieldCheck, Sparkles, Target, X, Sun, Moon,
} from 'lucide-react';
import type { GestureRecognizer, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import ShadowStrikeGame from './components/ShadowStrikeGame';
import AirOSDesktop from './components/AirOSDesktop';
import RealityScanOverlay from './components/RealityScanOverlay';
import HoloDeskScene from './components/HoloDeskScene';
import { deriveHandInput } from './vision/gestures';
import { deriveBodyInput } from './vision/bodyGestures';
import { AirHandGestureStabilizer, type AirHandGesture } from './vision/airHandEngine';
import { getRuntimeErrorDetails } from './vision/runtimeErrors';
import { EMPTY_BODY_INPUT, EMPTY_HAND_INPUT, type BodyInput, type HandInput, type Landmark } from './vision/types';

function getAirHandFrameGuidance(landmarks: readonly Landmark[] | undefined): string {
  if (!landmarks || landmarks.length < 21) return '';
  const xs = landmarks.map((point) => point.x);
  const ys = landmarks.map((point) => point.y);
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  if (left < 0.055 || right > 0.945 || top < 0.055 || bottom > 0.945) {
    return 'Hand near frame edge · move it toward the center';
  }
  const spanX = right - left, spanY = bottom - top;
  if (spanX > 0.78 || spanY > 0.82) return 'Hand too close · move it a little farther away';
  if (spanX < 0.16 && spanY < 0.20) return 'Hand looks small · move it a little closer';
  return '';
}

type ExperienceId = 'holodesk' | 'shadowstrike' | 'airos' | 'realityscan';
type Experience = {
  id: ExperienceId;
  number: string;
  title: string;
  category: string;
  description: string;
  detail: string;
  icon: typeof Hand;
  accent: string;
  tags: string[];
};

const experiences: Experience[] = [
  {
    id: 'holodesk', number: '01', title: 'HoloDesk', category: 'SPATIAL PLAYGROUND',
    description: 'Bring objects to life with your hands.',
    detail: 'Grab the hologram with a pinch, move it through space, and rotate it with your wrist. Mouse and touch dragging work without camera access too.',
    icon: Move3D, accent: 'violet', tags: ['Hand tracking', '3D space', 'Spatial input'],
  },
  {
    id: 'shadowstrike', number: '02', title: 'ShadowStrike', category: 'MOTION ARCADE',
    description: 'Your movement. Your controls. Your game.',
    detail: 'Move your body to steer through an arcade arena. Raise a hand to strike targets, jump to dodge, and use keyboard or touch controls as a fallback.',
    icon: Target, accent: 'orange', tags: ['Body tracking', 'Arcade', 'Motion input'],
  },
  {
    id: 'airos', number: '03', title: 'AirOS', category: 'TOUCHLESS WORKSPACE',
    description: 'A desktop that listens to gestures.',
    detail: 'An interactive browser desktop with movable windows and mini apps. Gestures control this workspace; it does not take over the operating system.',
    icon: Monitor, accent: 'blue', tags: ['Floating windows', 'Gesture UI', 'Mini apps'],
  },
  {
    id: 'realityscan', number: '04', title: 'RealityScan Live', category: 'COMPUTER VISION',
    description: 'See the world through a smarter lens.',
    detail: 'Detect everyday objects through the live camera and draw confidence-labelled tracking boxes in real time. Detection runs locally in the browser.',
    icon: ScanLine, accent: 'mint', tags: ['Live camera', 'Vision tools', 'Local processing'],
  },
];

// Keep the JavaScript runtime and WASM assets pinned to the exact release used by AirHand.
const mediaPipeRuntimeVersion = '0.10.22-rc.20250304';
const mediaPipeBundleCandidates = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${mediaPipeRuntimeVersion}/vision_bundle.mjs`,
  `https://unpkg.com/@mediapipe/tasks-vision@${mediaPipeRuntimeVersion}/vision_bundle.mjs`,
];
const visionWasmCandidates = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${mediaPipeRuntimeVersion}/wasm`,
  `https://unpkg.com/@mediapipe/tasks-vision@${mediaPipeRuntimeVersion}/wasm`,
];
// Some mobile networks can load the camera but block or interrupt Google Cloud Storage.
// Keep a second model mirror so camera permission success is not mistaken for model success.
const handModelCandidates = [
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'https://github.com/sanderdesnaijer/mediapipe-model-mirrors/releases/download/v1/hand_landmarker.task',
];
const gestureModelCandidates = [
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
];

const poseModelCandidates = [
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
];

export default function App() {
  const [active, setActive] = useState<ExperienceId | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Camera is off');
  const [handCount, setHandCount] = useState(0);
  const [fps, setFps] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('nexus-theme') === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });
  const handInputRef = useRef<HandInput>({ ...EMPTY_HAND_INPUT });
  const bodyInputRef = useRef<BodyInput>({ ...EMPTY_BODY_INPUT });
  const videoRef = useRef<HTMLVideoElement>(null);
  const gestureRecognizerRef = useRef<GestureRecognizer | null>(null);
  const gestureStabilizerRef = useRef(new AirHandGestureStabilizer(110));
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const lastHandCountRef = useRef(-1);
  const latestHandLandmarksRef = useRef<readonly Landmark[] | undefined>(undefined);
  const lastVideoTimeRef = useRef(-1);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const cameraSessionRef = useRef(0);
  const cameraStartingRef = useRef(false);
  const lastFrameRef = useRef(0);
  const lastVisionFrameRef = useRef(0);
  const frameCountRef = useRef(0);
  const activeExperience = experiences.find((item) => item.id === active) ?? null;

  useEffect(() => {
    try { localStorage.setItem('nexus-theme', theme); } catch { /* storage may be unavailable */ }
  }, [theme]);

  const stopCamera = useCallback(() => {
    cameraSessionRef.current += 1;
    cameraStartingRef.current = false;
    setCameraStarting(false);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    gestureRecognizerRef.current?.close();
    gestureRecognizerRef.current = null;
    gestureStabilizerRef.current.reset();
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    lastHandCountRef.current = -1;
    latestHandLandmarksRef.current = undefined;
    lastVideoTimeRef.current = -1;
    poseLandmarkerRef.current?.close();
    poseLandmarkerRef.current = null;
    bodyInputRef.current = { ...EMPTY_BODY_INPUT };
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    handInputRef.current = { ...EMPTY_HAND_INPUT };
    setHandCount(0);
    setFps(0);
    setCameraStatus('Camera is off');
  }, []);

  const startCamera = useCallback(async () => {
    if (cameraStartingRef.current || streamRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('Camera needs a supported browser and a secure connection.');
      return;
    }
    const sessionId = ++cameraSessionRef.current;
    cameraStartingRef.current = true;
    setCameraStarting(true);
    let requestedStream: MediaStream | null = null;
    let streamAttached = false;
    setCameraStatus('Requesting camera permission…');
    try {
      // RealityScan prefers the rear camera; the other experiences use a mirrored selfie view.
      const facingMode = active === 'realityscan' ? 'environment' : 'user';
      // Try modest mobile-friendly constraints first, then progressively relax them.
      // Some Android browsers reject a resolution/facing-mode combination even when
      // the camera itself is available.
      const videoRequests: MediaStreamConstraints[] = [
        { audio: false, video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } } },
        { audio: false, video: { facingMode: { ideal: facingMode } } },
        { audio: false, video: true },
      ];
      let stream: MediaStream | null = null;
      let cameraRequestError: unknown = null;
      for (const constraints of videoRequests) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (requestError) {
          cameraRequestError = requestError;
          const { name } = getRuntimeErrorDetails(requestError);
          // Permission/security failures cannot be repaired by changing constraints.
          if (['notallowederror', 'securityerror', 'permissiondeniederror'].includes(name.toLowerCase())) throw requestError;
        }
      }
      if (!stream) throw cameraRequestError ?? new Error('No camera stream was returned by the browser.');
      requestedStream = stream;
      if (sessionId !== cameraSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (!videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        cameraStartingRef.current = false;
        setCameraStarting(false);
        setCameraOn(false);
        setCameraStatus('Camera view is not ready. Leave this experience and open it again.');
        return;
      }
      const video = videoRef.current;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      // Wait briefly for metadata before play; mobile browsers often expose the
      // MediaStream before the video element has a usable frame size.
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          let timeout = 0;
          const cleanup = () => {
            window.clearTimeout(timeout);
            video.removeEventListener('loadedmetadata', onReady);
            video.removeEventListener('error', onError);
          };
          const onReady = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('The browser could not read video from the selected camera.')); };
          timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error('Camera connected but video metadata did not arrive within 8 seconds. Try reopening the camera.'));
          }, 8000);
          video.addEventListener('loadedmetadata', onReady, { once: true });
          video.addEventListener('error', onError, { once: true });
          // Metadata may arrive between the outer readyState check and listener registration.
          if (video.readyState >= HTMLMediaElement.HAVE_METADATA) onReady();
        });
      }
      await video.play();
      if (sessionId !== cameraSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      // A successful video stream is a camera success, independently of whether
      // the separate MediaPipe tracking model can be downloaded and initialized.
      streamAttached = true;
      cameraStartingRef.current = false;
      setCameraStarting(false);
      setCameraOn(true);
      setCameraStatus(active === 'shadowstrike'
        ? 'Camera connected · loading body tracking…'
        : active === 'realityscan'
          ? 'Camera connected · starting object detector…'
          : 'Camera connected · loading hand tracking…');

      // RealityScan owns its ObjectDetector. Avoid booting a second WASM runtime,
      // which wastes memory and can stall startup on mobile browsers.
      if (active === 'realityscan') {
        cameraStartingRef.current = false;
        setCameraStarting(false);
        setCameraOn(true);
        setCameraStatus('Camera connected · starting object detector…');
        let monitorLastFrame = performance.now();
        let monitorFrames = 0;
        let lastMonitorVideoTime = -1;
        const monitor = (now: number) => {
          if (sessionId !== cameraSessionRef.current) return;
          frameRef.current = requestAnimationFrame(monitor);
          // Count decoded camera frames, not requestAnimationFrame callbacks (which
          // can be 60+ FPS even when the camera itself only supplies 30 FPS).
          const monitorVideo = videoRef.current;
          if (monitorVideo && monitorVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              monitorVideo.currentTime !== lastMonitorVideoTime) {
            lastMonitorVideoTime = monitorVideo.currentTime;
            monitorFrames += 1;
          }
          if (now - monitorLastFrame >= 1000) {
            setFps(Math.round(monitorFrames * 1000 / Math.max(1, now - monitorLastFrame)));
            monitorFrames = 0;
            monitorLastFrame = now;
          }
        };
        frameRef.current = requestAnimationFrame(monitor);
        return;
      }

      setCameraStatus(active === 'shadowstrike' ? 'Loading pose-tracking model…' : 'Loading hand-tracking model…');
      let mediaPipeModule: typeof import('@mediapipe/tasks-vision') | null = null;
      let bundleError: unknown = null;
      for (const bundleUrl of mediaPipeBundleCandidates) {
        try {
          // @vite-ignore keeps this exact versioned browser bundle external, like AirHand.
          mediaPipeModule = await import(/* @vite-ignore */ bundleUrl) as typeof import('@mediapipe/tasks-vision');
          break;
        } catch (error) {
          bundleError = error;
        }
      }
      if (!mediaPipeModule) {
        const details = getRuntimeErrorDetails(bundleError);
        throw new Error(`MediaPipe JavaScript bundle failed to load from both CDNs (${details.name ? details.name + ': ' : ''}${details.message}). Check the connection or content blocker and retry.`);
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
        const details = getRuntimeErrorDetails(wasmError);
        throw new Error(`MediaPipe WASM runtime failed to load from both CDNs for release ${mediaPipeRuntimeVersion} (${details.name ? details.name + ': ' : ''}${details.message}). Check the connection or content blocker and retry.`);
      }
      if (sessionId !== cameraSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const trackHands = active !== 'shadowstrike';
      const trackBody = active === 'shadowstrike';
      const trackingOptions = {
        runningMode: 'VIDEO' as const,
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
      };
      if (trackHands) {
        // Use the same trained GestureRecognizer-first strategy as AirHand's browser app.
        // The separate HandLandmarker fallback preserves cursor/pinch operation when the
        // gesture classifier or its model cannot be loaded on a mobile network.
        const gestureOptions = {
          runningMode: 'VIDEO' as const,
          numHands: 2,
          minHandDetectionConfidence: 0.62,
          minHandPresenceConfidence: 0.60,
          minTrackingConfidence: 0.60,
        };
        let recognizer: GestureRecognizer | null = null;
        let gestureModelError: unknown = null;
        for (const delegate of ['GPU', 'CPU'] as const) {
          try {
            recognizer = await mediaPipeModule.GestureRecognizer.createFromOptions(vision, {
              ...gestureOptions,
              baseOptions: { modelAssetPath: gestureModelCandidates[0], delegate },
            });
            break;
          } catch (error) {
            gestureModelError = error;
          }
        }

        if (recognizer) {
          if (sessionId !== cameraSessionRef.current) {
            recognizer.close();
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          gestureRecognizerRef.current = recognizer;
        } else {
          let fallbackLandmarker: HandLandmarker | null = null;
          let fallbackError: unknown = gestureModelError;
          for (const modelAssetPath of handModelCandidates) {
            for (const delegate of ['GPU', 'CPU'] as const) {
              try {
                fallbackLandmarker = await mediaPipeModule.HandLandmarker.createFromOptions(vision, {
                  ...trackingOptions,
                  baseOptions: { modelAssetPath, delegate },
                });
                break;
              } catch (error) {
                fallbackError = error;
              }
            }
            if (fallbackLandmarker) break;
          }
          if (!fallbackLandmarker) {
            const gestureDetails = getRuntimeErrorDetails(gestureModelError);
            const fallbackDetails = getRuntimeErrorDetails(fallbackError);
            throw new Error(
              'Both AirHand-style gesture recognition and landmark fallback failed. ' +
              'Gesture model: ' + (gestureDetails.message || gestureDetails.name || 'unavailable') +
              '. Landmark model: ' + (fallbackDetails.message || fallbackDetails.name || 'unavailable') +
              '. Check the network/model download and retry.'
            );
          }
          if (sessionId !== cameraSessionRef.current) {
            fallbackLandmarker.close();
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          landmarkerRef.current = fallbackLandmarker;
        }
      }
      if (trackBody) {
        const poseOptions = {
          runningMode: 'VIDEO' as const,
          numPoses: 1,
          minPoseDetectionConfidence: 0.55,
          minPosePresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
          outputSegmentationMasks: false,
        };
        let poseLandmarker: PoseLandmarker | null = null;
        let poseModelError: unknown = null;
        for (const modelAssetPath of poseModelCandidates) {
          for (const delegate of ['GPU', 'CPU'] as const) {
            try {
              poseLandmarker = await mediaPipeModule.PoseLandmarker.createFromOptions(vision, {
                ...poseOptions,
                baseOptions: { modelAssetPath, delegate },
              });
              break;
            } catch (error) {
              poseModelError = error;
            }
          }
          if (poseLandmarker) break;
        }
        if (!poseLandmarker) {
          const details = getRuntimeErrorDetails(poseModelError);
          throw new Error(`Pose model failed to load (${details.name ? details.name + ': ' : ''}${details.message}). Check the network and retry.`);
        }
        if (sessionId !== cameraSessionRef.current) {
          poseLandmarker.close();
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        poseLandmarkerRef.current = poseLandmarker;
      }
      if (sessionId !== cameraSessionRef.current) return;
      cameraStartingRef.current = false;
      setCameraStarting(false);
      setCameraOn(true);
      setCameraStatus('Vision engine online');
      lastVisionFrameRef.current = 0;
      lastFrameRef.current = performance.now();
      frameCountRef.current = 0;
      lastVideoTimeRef.current = -1;
      latestHandLandmarksRef.current = undefined;
      gestureStabilizerRef.current.reset();
      lastHandCountRef.current = -1;
      let consecutiveInferenceErrors = 0;
      let lastLoopStatus = '';
      const publishLoopStatus = (status: string) => {
        if (status !== lastLoopStatus) {
          lastLoopStatus = status;
          setCameraStatus(status);
        }
      };
      const loop = (now: number) => {
        if (sessionId !== cameraSessionRef.current) return;
        const video = videoRef.current;
        const recognizer = gestureRecognizerRef.current;
        const tracker = landmarkerRef.current;
        const poseTracker = poseLandmarkerRef.current;
        if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 2 || video.videoHeight < 2) {
          frameRef.current = requestAnimationFrame(loop);
          return;
        }
        // Like AirHand, infer only on fresh camera frames. This avoids repeatedly
        // submitting the same frame when the screen refreshes faster than the camera.
        if (now - lastVisionFrameRef.current < 33 || video.currentTime === lastVideoTimeRef.current) {
          frameRef.current = requestAnimationFrame(loop);
          return;
        }
        lastVisionFrameRef.current = now;
        lastVideoTimeRef.current = video.currentTime;
        let inferenceFailed = false;
        let currentHandCount = 0;
        try {
          if (recognizer) {
            const result = recognizer.recognizeForVideo(video, now);
            const landmarks = result.landmarks ?? [];
            const topGesture = result.gestures?.[0]?.[0];
            latestHandLandmarksRef.current = landmarks[0];
            handInputRef.current = deriveHandInput(
              landmarks[0], now, handInputRef.current.pinch,
              topGesture?.categoryName ?? null, topGesture?.score ?? 0,
            );
            currentHandCount = landmarks.length;
          } else if (tracker) {
            const result = tracker.detectForVideo(video, now);
            const landmarks = result.landmarks ?? [];
            latestHandLandmarksRef.current = landmarks[0];
            handInputRef.current = deriveHandInput(landmarks[0], now, handInputRef.current.pinch);
            currentHandCount = landmarks.length;
          } else {
            handInputRef.current = { ...EMPTY_HAND_INPUT };
          }
        } catch (error) {
          inferenceFailed = true;
          handInputRef.current = { ...EMPTY_HAND_INPUT };
          latestHandLandmarksRef.current = undefined;
          gestureStabilizerRef.current.reset();
          if (consecutiveInferenceErrors === 0) console.warn('Nexus hand-tracking frame failed; retrying.', error);
        }
        // AirHand stabilizes noisy gesture changes and releases immediately on tracking loss.
        const stableGesture = gestureStabilizerRef.current.update(
          (handInputRef.current.gesture ?? 'None') as AirHandGesture,
          now,
        );
        handInputRef.current = {
          ...handInputRef.current,
          pinch: handInputRef.current.detected && stableGesture === 'Pinch',
        };
        if (currentHandCount !== lastHandCountRef.current) {
          lastHandCountRef.current = currentHandCount;
          setHandCount(currentHandCount);
        }

        if (poseTracker) {
          try {
            const poseResult = poseTracker.detectForVideo(video, now);
            bodyInputRef.current = deriveBodyInput(poseResult.landmarks[0], now);
          } catch (error) {
            inferenceFailed = true;
            bodyInputRef.current = { ...EMPTY_BODY_INPUT };
            if (consecutiveInferenceErrors === 0) console.warn('Nexus pose-tracking frame failed; retrying.', error);
          }
        } else {
          bodyInputRef.current = { ...EMPTY_BODY_INPUT };
        }

        if (inferenceFailed) {
          latestHandLandmarksRef.current = undefined;
          consecutiveInferenceErrors += 1;
          publishLoopStatus(consecutiveInferenceErrors >= 8
            ? 'Vision inference failing · restart the camera'
            : 'Tracking hiccup · retrying vision engine…');
        } else {
          consecutiveInferenceErrors = 0;
          if (recognizer || tracker) {
            const guidance = currentHandCount > 0 ? getAirHandFrameGuidance(latestHandLandmarksRef.current) : '';
            publishLoopStatus(currentHandCount > 0
              ? (guidance || 'Hand detected · ' + (recognizer ? 'AirHand gesture recognizer' : 'landmark fallback'))
              : 'Tracking ready · place your hand fully in frame');
          } else if (poseTracker) {
            publishLoopStatus('Pose tracking ready · stand inside the frame');
          } else {
            publishLoopStatus('Vision runtime ready · no active tracker');
          }
        }

        frameCountRef.current += 1;
        if (now - lastFrameRef.current >= 1000) {
          setFps(frameCountRef.current);
          frameCountRef.current = 0;
          lastFrameRef.current = now;
        }
        frameRef.current = requestAnimationFrame(loop);
      };
      frameRef.current = requestAnimationFrame(loop);
    } catch (error) {
      if (!streamAttached) {
        requestedStream?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      } else if (requestedStream) {
        // Keep a working camera preview alive when only the vision model failed.
        streamRef.current = requestedStream;
      }
      if (sessionId !== cameraSessionRef.current) return;
      handInputRef.current = { ...EMPTY_HAND_INPUT };
      gestureRecognizerRef.current?.close();
      gestureRecognizerRef.current = null;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
      poseLandmarkerRef.current?.close();
      poseLandmarkerRef.current = null;
      bodyInputRef.current = { ...EMPTY_BODY_INPUT };
      cameraStartingRef.current = false;
      setCameraStarting(false);
      setCameraOn(streamAttached);

      const { name: errorName, message } = getRuntimeErrorDetails(error);
      const normalized = `${errorName} ${message}`.toLowerCase();
      if (streamAttached) {
        // The video stream is valid; keep it alive if only model initialization failed.
        const trackingMode = active === 'shadowstrike' ? 'body tracking' : 'hand tracking';
        const detail = `${errorName ? errorName + ': ' : ''}${message}`.replace(/\s+/g, ' ').slice(0, 135);
        setCameraStatus(`Camera connected, but ${trackingMode} failed — ${detail}. Stop and retry to reload tracking.`);
      } else if (normalized.includes('notallowed') || normalized.includes('permission') || normalized.includes('denied') || normalized.includes('securityerror')) {
        setCameraStatus('Camera access blocked by the browser. Check Chrome Site settings → Camera, then reload Nexus.');
      } else if (normalized.includes('notfound') || normalized.includes('devicesnotfound')) {
        setCameraStatus('No camera was found. Close other camera apps and retry.');
      } else if (normalized.includes('notreadable') || normalized.includes('trackstart')) {
        setCameraStatus('Camera is busy or unavailable. Close other camera apps, then retry.');
      } else if (normalized.includes('overconstrained')) {
        setCameraStatus('The camera rejected its settings. The fallback settings also failed.');
      } else if (normalized.includes('insecure') || normalized.includes('secure context')) {
        setCameraStatus('Camera requires HTTPS. Open the official Nexus HTTPS address.');
      } else {
        const detail = `${errorName ? errorName + ': ' : ''}${message}`.replace(/\s+/g, ' ').slice(0, 135);
        setCameraStatus('Camera startup failed — ' + detail);
      }
    }
  }, [active]);

  useEffect(() => () => {
    cameraSessionRef.current += 1;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    landmarkerRef.current?.close();
    poseLandmarkerRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const openExperience = (id: ExperienceId) => {
    stopCamera();
    setActive(id);
  };

  const goHome = () => {
    stopCamera();
    setActive(null);
  };

  return (
    <main className={'app-shell theme-' + theme}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <button className="brand" onClick={goHome} aria-label="Nexus home">
          <span className="brand-mark"><Command size={19} strokeWidth={2.2} /></span>
          <span>NEXUS<span className="brand-period">.</span></span>
          <span className="brand-beta">PREVIEW</span>
        </button>
        <div className="topbar-right">
          <span className="connection-pill"><span className="status-dot" /> LOCAL VISION</span>
          <button className="icon-button" onClick={() => setShowHelp(true)} aria-label="Help"><CircleHelp size={18} /></button>
          <button className="icon-button theme-toggle" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
          <button className="icon-button" onClick={() => setShowHelp(true)} aria-label="Settings"><Settings2 size={18} /></button>
          <div className="avatar">NX</div>
        </div>
      </header>

      {activeExperience ? (
        <section className="workspace">
          <div className="workspace-toolbar">
            <button className="back-button" onClick={goHome}><ArrowLeft size={16} /> All experiences</button>
            <span className="workspace-breadcrumb">NEXUS / {activeExperience.title.toUpperCase()}</span>
            <span className="workspace-version">ENGINE 0.1</span>
          </div>
          <div className="workspace-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> EXPERIENCE {activeExperience.number}</div>
              <h1>{activeExperience.title}<span className="brand-period">.</span></h1>
              <p>{activeExperience.detail}</p>
            </div>
            <div className="workspace-actions">
              {cameraOn || cameraStarting ? (
                <button className="button button-secondary" onClick={stopCamera}><X size={16} /> {cameraStarting ? 'Cancel startup' : 'Stop camera'}</button>
              ) : (
                <button className="button button-primary" onClick={() => void startCamera()}><Camera size={16} /> Enable camera <ArrowRight size={16} /></button>
              )}
            </div>
          </div>
          <div className="workspace-grid">
            <div className="camera-panel">
              <div className="panel-topline">
                <span><span className={cameraOn ? 'status-dot active' : 'status-dot'} /> LIVE INPUT</span>
                <span className="panel-topline-right">{cameraOn ? 'CAMERA CONNECTED' : cameraStarting ? 'STARTING CAMERA' : 'AWAITING INPUT'}</span>
              </div>
              <div className={'camera-stage ' + (cameraOn || cameraStarting ? 'camera-stage-live' : '') + (activeExperience.id === 'holodesk' ? ' is-holodesk' : '') + (activeExperience.id === 'shadowstrike' ? ' is-shadowstrike' : '') + (activeExperience.id === 'airos' ? ' is-airos' : '') + (activeExperience.id === 'realityscan' ? ' is-realityscan' : '')}>
                <video ref={videoRef} className={(cameraOn || cameraStarting ? 'camera-video visible' : 'camera-video') + (activeExperience.id === 'realityscan' ? ' realityscan-camera-video' : '')} autoPlay playsInline muted />
                {!cameraOn && !cameraStarting && activeExperience.id !== 'shadowstrike' && activeExperience.id !== 'airos' && <div className="camera-placeholder">
                  <div className="camera-orbit"><div className="orbit-ring orbit-ring-one" /><div className="orbit-ring orbit-ring-two" /><div className="camera-symbol"><Camera size={28} /></div></div>
                  <h3>{activeExperience.id === 'holodesk' ? 'Touchless 3D is ready.' : 'Give Nexus a point of view.'}</h3>
                  <p>{activeExperience.id === 'holodesk' ? 'Drag the hologram to move it. Enable the camera to grab it with a pinch.' : 'Enable your camera to initialize the shared vision engine.'}</p>
                  {activeExperience.id !== 'holodesk' && <button className="button button-primary" onClick={() => void startCamera()}><Camera size={16} /> Enable camera</button>}
                  <span className="permission-note"><ShieldCheck size={13} /> Camera starts only when you ask</span>
                </div>}
                {cameraOn && activeExperience.id === 'holodesk' && <div className="tracking-overlay">
                  <span className="tracking-label"><span className="status-dot active" /> TRACKING ACTIVE</span>
                  <span className="tracking-counter">{String(handCount).padStart(2, '0')} HAND{handCount === 1 ? '' : 'S'}</span>
                  <div className="scanline" />
                </div>}
                {activeExperience.id === 'holodesk' && <HoloDeskScene inputRef={handInputRef} cameraEnabled={cameraOn} />}
                {activeExperience.id === 'shadowstrike' && <ShadowStrikeGame bodyInputRef={bodyInputRef} cameraEnabled={cameraOn} />}
                {activeExperience.id === 'airos' && <AirOSDesktop inputRef={handInputRef} cameraEnabled={cameraOn} onSwitchExperience={openExperience} />}
                {activeExperience.id === 'realityscan' && <RealityScanOverlay active={cameraOn} videoRef={videoRef} onStatusChange={setCameraStatus} />}
              </div>
              <div className="camera-footer">
                <span className="camera-status"><span className={cameraOn || cameraStarting ? 'status-dot active' : 'status-dot'} /> {cameraStatus}</span>
                <span className="camera-fps">{cameraOn || cameraStarting ? fps + ' FPS · ' + (activeExperience.id === 'shadowstrike' ? (bodyInputRef.current.detected ? 'body tracked' : 'find full body') : activeExperience.id === 'realityscan' ? 'camera frames' : handCount + ' hands') : 'NO SIGNAL'}</span>
              </div>
            </div>
            <aside className="inspector">
              <div className="inspector-title"><span>SESSION INSPECTOR</span><span className="inspector-icon"><Layers3 size={15} /></span></div>
              <div className="inspector-section">
                <span className="field-label">CURRENT EXPERIENCE</span>
                <div className="selected-experience"><div className={'mini-icon ' + activeExperience.accent}><activeExperience.icon size={19} /></div><div><strong>{activeExperience.title}</strong><span>{activeExperience.category}</span></div><Check size={16} className="check-icon" /></div>
              </div>
              <div className="inspector-section">
                <span className="field-label">VISION ENGINE</span>
                <div className="metric-row"><span>Camera</span><span className={cameraOn ? 'metric-value online' : 'metric-value'}>{cameraOn ? 'Connected' : cameraStarting ? 'Starting…' : 'Standby'}</span></div>
                <div className="metric-row"><span>{activeExperience.id === 'shadowstrike' ? 'Body pose' : activeExperience.id === 'realityscan' ? 'Object model' : 'Hand landmarks'}</span><span className="metric-value">{cameraOn ? (activeExperience.id === 'shadowstrike' ? (bodyInputRef.current.detected ? 'Detected' : 'Searching') : activeExperience.id === 'realityscan' ? 'Loading / active' : handCount + ' detected') : 'Waiting'}</span></div>
                <div className="metric-row"><span>Frame rate</span><span className="metric-value">{cameraOn ? fps + ' FPS' : '—'}</span></div>
                <div className="metric-row"><span>Processing</span><span className="metric-value">On-device</span></div>
              </div>
              <div className="inspector-section">
                <span className="field-label">EXPERIENCE MODULES</span>
                <div className="tag-list">{activeExperience.tags.map((tag) => <span className="feature-tag" key={tag}>{tag}</span>)}</div>
              </div>
              <div className="inspector-note"><Sparkles size={15} /><p><strong>Built to grow.</strong> The shared camera and tracking layer is being developed once, then reused across all four experiences.</p></div>
            </aside>
          </div>
          <div className="workspace-bottom">
            <div><span className="bottom-label">QUICK SWITCH</span><div className="quick-switch">{experiences.filter((item) => item.id !== active).map((item) => <button key={item.id} onClick={() => openExperience(item.id)}><item.icon size={15} /> {item.title} <ChevronRight size={13} /></button>)}</div></div>
            <span className="build-label">NEXUS PREVIEW <span>·</span> BUILD 0.1.0</span>
          </div>
        </section>
      ) : (
        <section className="home">
          <div className="hero">
            <div className="eyebrow"><span className="eyebrow-line" /> A NEW WAY TO INTERACT</div>
            <h1>The world<br />beyond <span className="gradient-text">touch.</span></h1>
            <p className="hero-copy">Four experimental experiences. One camera. A whole new way to play, create, and interact with the digital world.</p>
            <div className="hero-actions">
              <button className="button button-primary" onClick={() => openExperience('holodesk')}><Play size={16} fill="currentColor" /> Enter the playground <ArrowRight size={16} /></button>
              <span className="hero-meta"><span className="status-dot active" /> 4 EXPERIENCES <span className="meta-divider">/</span> CAMERA OPTIONAL</span>
            </div>
            <div className="hero-decoration" aria-hidden="true"><div className="hero-ring ring-a" /><div className="hero-ring ring-b" /><div className="hero-ring ring-c" /><div className="hero-center"><Hand size={42} strokeWidth={1.1} /></div><div className="hero-cross cross-a" /><div className="hero-cross cross-b" /><div className="hero-cross cross-c" /><div className="hero-coordinate">SPATIAL INPUT<br />3 AXES / LIVE</div><div className="hero-chip chip-a">GESTURE INPUT <span>READY</span></div><div className="hero-chip chip-b"><span className="status-dot active" /> REAL-TIME VISION</div></div>
          </div>
          <div className="section-heading">
            <div><div className="eyebrow"><span className="eyebrow-line" /> YOUR PLAYGROUND</div><h2>Choose your reality<span className="brand-period">.</span></h2></div>
            <span className="section-count">01 — 04 <ArrowRight size={14} /></span>
          </div>
          <div className="experience-grid">
            {experiences.map((experience) => (
              <button className={'experience-card ' + experience.accent} key={experience.id} onClick={() => openExperience(experience.id)}>
                <div className="card-top"><span className="card-number">{experience.number} / NEXUS</span><span className="card-arrow"><ArrowRight size={17} /></span></div>
                <div className="card-visual">
                  {experience.id === 'holodesk' && <div className="visual-holo"><div className="holo-orbit holo-one" /><div className="holo-orbit holo-two" /><div className="holo-cube"><div className="cube-face cube-front" /><div className="cube-face cube-back" /><div className="cube-face cube-left" /><div className="cube-face cube-right" /><div className="cube-face cube-top" /><div className="cube-face cube-bottom" /></div><div className="holo-dot dot-one" /><div className="holo-dot dot-two" /><div className="holo-dot dot-three" /></div>}
                  {experience.id === 'shadowstrike' && <div className="visual-game"><div className="game-grid" /><div className="game-target target-one" /><div className="game-target target-two" /><div className="game-target target-three" /><div className="game-player"><div className="player-head" /><div className="player-body" /><div className="player-arm arm-left" /><div className="player-arm arm-right" /><div className="player-leg leg-left" /><div className="player-leg leg-right" /></div><div className="game-score">SCORE <b>00840</b></div></div>}
                  {experience.id === 'airos' && <div className="visual-os"><div className="os-window os-window-back"><span /><span /><span /></div><div className="os-window os-window-front"><div className="os-title"><i /><i /><i /></div><div className="os-lines"><span /><span /><span /><span /></div><div className="os-widget"><Monitor size={17} /><span>Gesture<br />workspace</span></div></div><div className="os-cursor"><Move3D size={18} /></div></div>}
                  {experience.id === 'realityscan' && <div className="visual-scan"><div className="scan-object"><div className="scan-box"><span className="scan-corner corner-1" /><span className="scan-corner corner-2" /><span className="scan-corner corner-3" /><span className="scan-corner corner-4" /><span className="scan-label">OBJECT TRACKED</span></div><div className="scan-cube"><div /><div /><div /><div /><div /><div /></div></div><div className="scan-hud">LIVE / 30 FPS</div><div className="scan-line" /></div>}
                </div>
                <div className="card-content"><span className="card-category">{experience.category}</span><h3>{experience.title}<span className="brand-period">.</span></h3><p>{experience.description}</p></div>
                <div className="card-bottom"><span><span className="status-dot active" /> OPEN EXPERIENCE</span><ChevronRight size={16} /></div>
              </button>
            ))}
          </div>
          <div className="bottom-strip"><div className="strip-icon"><ShieldCheck size={17} /></div><div><strong>Privacy by design</strong><span>Your camera stays off until you enable it. Vision processing runs locally in your browser.</span></div><div className="strip-right"><span className="status-dot active" /> NO ACCOUNT REQUIRED</div></div>
          <footer className="site-footer"><span>© 2026 NEXUS LABS</span><span>MADE FOR THE CURIOUS <Sparkles size={12} /></span><button onClick={() => setShowHelp(true)}>ABOUT THE PROJECT <ArrowRight size={12} /></button></footer>
        </section>
      )}

      {showHelp && <div className="modal-backdrop" role="presentation" onClick={() => setShowHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setShowHelp(false)} aria-label="Close help"><X size={18} /></button><div className="modal-icon"><CircleHelp size={22} /></div><div className="eyebrow">QUICK GUIDE</div><h2 id="help-title">Welcome to Nexus.</h2><p>Nexus is an experimental playground for camera-based interaction. Choose an experience to enter its workspace, then enable the camera to test the shared tracking engine. Switch between light and dark themes using the sun/moon button in the top bar.</p><div className="help-list"><div><Camera size={16} /><span><strong>Camera access</strong><small>Requested only when you press Enable camera. Use HTTPS or localhost.</small></span></div><div><ShieldCheck size={16} /><span><strong>Privacy</strong><small>Video is processed in your browser and is not uploaded by this app.</small></span></div><div><Maximize2 size={16} /><span><strong>Good tracking</strong><small>Use bright, even light and keep your hand fully visible.</small></span></div><div><Hand size={16} /><span><strong>HoloDesk & AirOS</strong><small>Move your hand to move the cursor. Pinch thumb and index finger to grab the HoloDesk object or an AirOS window title; release to drop it.</small></span></div><div><Target size={16} /><span><strong>ShadowStrike</strong><small>Move your body to steer, raise a hand to strike, and jump to dodge. Keep your full body in view.</small></span></div><div><ScanLine size={16} /><span><strong>RealityScan Live</strong><small>Point the camera at everyday objects. This experience detects objects rather than using hand gestures to operate every control.</small></span></div></div><button className="button button-primary modal-done" onClick={() => setShowHelp(false)}>Got it <Check size={16} /></button></section></div>}
    </main>
  );
}
