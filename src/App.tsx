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
import { AirHandCursorCalibrator, AirHandCursorSmoother, AirHandGestureStabilizer, mapCalibratedCursor, validateCursorBounds, type AirHandCursorBounds, type AirHandGesture } from './vision/airHandEngine';
import { getRuntimeErrorDetails } from './vision/runtimeErrors';
import { clampGesturePointer, GestureActivationGate } from './vision/gestureNavigation';
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
  const [calibratingCursor, setCalibratingCursor] = useState(false);
  const [calibrationMessage, setCalibrationMessage] = useState('Not calibrated');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('nexus-theme') === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });
  const handInputRef = useRef<HandInput>({ ...EMPTY_HAND_INPUT });
  const globalGestureCursorRef = useRef<HTMLDivElement>(null);
  const globalHoveredElementRef = useRef<HTMLElement | null>(null);
  const globalGestureActivationGateRef = useRef(new GestureActivationGate());
  const globalCursorSmootherRef = useRef(new AirHandCursorSmoother());
  const handScrollRef = useRef<{ active: boolean; lastY: number; lastAt: number }>({ active: false, lastY: 0.5, lastAt: 0 });
  const cursorCalibratorRef = useRef<AirHandCursorCalibrator | null>(null);
  const calibratingCursorRef = useRef(false);
  const cursorBoundsRef = useRef<AirHandCursorBounds | null>(null);
  const calibrationSamplesRef = useRef(0);
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
  const restartCameraAfterExperienceSwitchRef = useRef(false);
  const lastFrameRef = useRef(0);
  const lastVisionFrameRef = useRef(0);
  const frameCountRef = useRef(0);
  const activeExperience = experiences.find((item) => item.id === active) ?? null;

  const startCursorCalibration = useCallback(() => {
    cursorCalibratorRef.current = new AirHandCursorCalibrator(30, 0.18, 0.035);
    calibrationSamplesRef.current = 0;
    setCalibrationMessage('Move your hand slowly across the full camera view…');
    calibratingCursorRef.current = true;
    setCalibratingCursor(true);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('nexus-theme', theme);
      const stored = localStorage.getItem('nexus-cursor-bounds');
      if (stored) {
        const bounds = JSON.parse(stored) as AirHandCursorBounds;
        if (validateCursorBounds(bounds)) cursorBoundsRef.current = bounds;
      }
    } catch { /* local storage may be unavailable */ }
  }, [theme]);

  useEffect(() => {
    const cursor = globalGestureCursorRef.current;
    if (!cursor) return;
    let frame = 0;
    const clearHover = () => {
      globalHoveredElementRef.current?.classList.remove('global-gesture-hover');
      globalHoveredElementRef.current = null;
    };
    const scrollAtPoint = (x: number, y: number, delta: number) => {
      if (!Number.isFinite(delta) || Math.abs(delta) < 1) return;
      const hit = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight) as HTMLElement | null;
      let node: HTMLElement | null = hit;
      while (node && node !== document.body && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        const canScroll = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2;
        if (canScroll) {
          const before = node.scrollTop;
          node.scrollTop += delta;
          if (node.scrollTop !== before) return;
        }
        node = node.parentElement;
      }
      window.scrollBy({ top: delta, behavior: 'auto' });
    };
    const tick = () => {
      const hand = handInputRef.current;
      // AirOS owns its internal cursor and window gestures. ShadowStrike uses
      // full-body controls, so avoid competing with its hand/body camera pipeline.
      const enabled = cameraOn && active !== 'shadowstrike';
      if (!enabled) {
        cursor.style.visibility = 'hidden';
        cursor.classList.remove('global-gesture-pinching');
        clearHover();
        globalGestureActivationGateRef.current.reset();
        handScrollRef.current.active = false;
        frame = requestAnimationFrame(tick);
        return;
      }
      const isScrollGesture = hand.detected && hand.gesture === 'Fist' && !hand.pinch;
      const clickStarted = globalGestureActivationGateRef.current.update(hand.detected && !isScrollGesture, hand.detected && hand.pinch && !isScrollGesture);
      if (!hand.detected) {
        handScrollRef.current.active = false;
        cursor.classList.remove('global-gesture-scrolling');
        // Tracking loss hides interaction and disarms clicks until a visible release.
        // Do not let a held pinch accidentally activate again when the hand reappears.
        cursor.style.visibility = 'hidden';
        cursor.classList.remove('global-gesture-pinching');
        clearHover();
        frame = requestAnimationFrame(tick);
        return;
      }
      // The rear-camera RealityScan preview is not mirrored; undo the standard selfie mirror there.
      const normalizedX = active === 'realityscan' ? 1 - hand.x : hand.x;
      const rawX = clampGesturePointer(normalizedX);
      const rawY = clampGesturePointer(hand.y);
      const smoothed = globalCursorSmootherRef.current.update(rawX, rawY, performance.now());
      const x = clampGesturePointer(smoothed.x);
      const y = clampGesturePointer(smoothed.y);
      const hit = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight) as HTMLElement | null;
      if (isScrollGesture) {
        cursor.style.visibility = 'visible';
        cursor.style.left = (x * 100) + 'vw';
        cursor.style.top = (y * 100) + 'vh';
        cursor.classList.remove('global-gesture-pinching');
        cursor.classList.add('global-gesture-scrolling');
        clearHover();
        const scrollState = handScrollRef.current;
        const now = performance.now();
        if (scrollState.active && now - scrollState.lastAt < 120) {
          const delta = (scrollState.lastY - y) * window.innerHeight * 1.35;
          scrollAtPoint(x, y, delta);
        }
        handScrollRef.current = { active: true, lastY: y, lastAt: now };
        frame = requestAnimationFrame(tick);
        return;
      }
      handScrollRef.current.active = false;
      cursor.classList.remove('global-gesture-scrolling');
      // AirOS draws its own low-latency cursor inside the desktop surface. Keep
      // that cursor exclusive there, but allow the global cursor to operate the
      // workspace toolbar and camera controls outside the desktop.
      if (active === 'airos' && hit?.closest('.air-os-layer')) {
        cursor.style.visibility = 'hidden';
        clearHover();
        frame = requestAnimationFrame(tick);
        return;
      }
      cursor.style.visibility = 'visible';
      cursor.style.left = (x * 100) + 'vw';
      cursor.style.top = (y * 100) + 'vh';
      cursor.classList.toggle('global-gesture-pinching', hand.pinch);
      const target = hit?.closest<HTMLElement>('.app-shell button:not(:disabled), .app-shell [role="button"], .app-shell a[href]') ?? null;
      {
        if (target !== globalHoveredElementRef.current) {
          clearHover();
          target?.classList.add('global-gesture-hover');
          globalHoveredElementRef.current = target;
        }
        if (clickStarted && target) target.click();
      }
      frame = requestAnimationFrame(tick);
    };
    if (cameraOn && active !== 'shadowstrike') {
      frame = requestAnimationFrame(tick);
    } else {
      cursor.style.visibility = 'hidden';
      clearHover();
      globalGestureActivationGateRef.current.reset();
    }
    return () => {
      cancelAnimationFrame(frame);
      clearHover();
      cursor.style.visibility = 'hidden';
      cursor.classList.remove('global-gesture-pinching');
      globalGestureActivationGateRef.current.reset();
    };
  }, [active, cameraOn]);



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
        // Sample raw coordinates so the calibration never trains on its own output.
        if (calibratingCursorRef.current && handInputRef.current.detected && cursorCalibratorRef.current) {
          cursorCalibratorRef.current.add(handInputRef.current.x, handInputRef.current.y);
          calibrationSamplesRef.current += 1;
          if (calibrationSamplesRef.current >= 60) {
            const bounds = cursorCalibratorRef.current.finish();
            cursorCalibratorRef.current = null;
            calibratingCursorRef.current = false;
            setCalibratingCursor(false);
            if (bounds) {
              cursorBoundsRef.current = bounds;
              try { localStorage.setItem('nexus-cursor-bounds', JSON.stringify(bounds)); } catch { /* keep bounds for this session */ }
              setCalibrationMessage('Calibrated · saved on this device');
            } else {
              setCalibrationMessage('Move farther in both directions and try again.');
            }
          }
        }
        const bounds = cursorBoundsRef.current;
        if (handInputRef.current.detected && bounds) {
          const mapped = mapCalibratedCursor(handInputRef.current.x, handInputRef.current.y, bounds);
          if (mapped) handInputRef.current = { ...handInputRef.current, x: mapped.x, y: mapped.y };
        }
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

  useEffect(() => {
    if (!restartCameraAfterExperienceSwitchRef.current) return;
    restartCameraAfterExperienceSwitchRef.current = false;
    // Wait until React has mounted the new experience's video element.
    const frame = window.requestAnimationFrame(() => { void startCamera(); });
    return () => window.cancelAnimationFrame(frame);
  }, [active, startCamera]);

  useEffect(() => () => {
    cameraSessionRef.current += 1;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    landmarkerRef.current?.close();
    poseLandmarkerRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const openExperience = (id: ExperienceId) => {
    // A gesture-selected experience is part of the current opted-in session.
    // Restart the camera/model for the new experience instead of forcing a touch
    // tap on "Enable camera" after every hand-controlled switch.
    restartCameraAfterExperienceSwitchRef.current = cameraOn;
    stopCamera();
    setActive(id);
  };

  const goHome = () => {
    // Keep a user's explicit hands-free opt-in when returning to Nexus Home.
    // The hidden home video element mounts before the restart effect runs.
    restartCameraAfterExperienceSwitchRef.current = cameraOn;
    stopCamera();
    setActive(null);
  };

  const handleAirOSNavigation = (id: ExperienceId | 'home') => {
    if (id === 'home') {
      goHome();
      return;
    }
    openExperience(id);
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
                {activeExperience.id === 'airos' && <AirOSDesktop inputRef={handInputRef} cameraEnabled={cameraOn} onSwitchExperience={handleAirOSNavigation} theme={theme} onToggleTheme={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} />}
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
              {activeExperience.id !== 'shadowstrike' && activeExperience.id !== 'realityscan' && <div className="inspector-section">
                <span className="field-label">HAND CURSOR CALIBRATION</span>
                <div className="metric-row"><span>Profile</span><span className="metric-value">{calibrationMessage}</span></div>
                <p className="inspector-description">Move your hand left, right, up and down while calibration runs. The learned range is stored locally in this browser.</p>
                <button className="button button-secondary" disabled={!cameraOn || calibratingCursor} onClick={startCursorCalibration}>
                  <Target size={15} /> {calibratingCursor ? 'Calibrating…' : 'Calibrate hand cursor'}
                </button>
                {calibratingCursor && <button className="button button-ghost" onClick={() => { cursorCalibratorRef.current = null; calibratingCursorRef.current = false; setCalibratingCursor(false); setCalibrationMessage('Calibration cancelled'); }}>Cancel calibration</button>}
              </div>}
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
          <video ref={videoRef} className="home-camera-feed" autoPlay playsInline muted aria-hidden="true" tabIndex={-1} />
          <div className="hero">
            <div className="eyebrow"><span className="eyebrow-line" /> A NEW WAY TO INTERACT</div>
            <h1>The world<br />beyond <span className="gradient-text">touch.</span></h1>
            <p className="hero-copy">Four experimental experiences. One camera. A whole new way to play, create, and interact with the digital world.</p>
            <div className="hero-actions">
              <button className="button button-primary" onClick={() => openExperience('holodesk')}><Play size={16} fill="currentColor" /> Enter the playground <ArrowRight size={16} /></button>
              {cameraOn || cameraStarting
                ? <button className="button button-secondary handsfree-home-toggle" onClick={stopCamera}><X size={15} /> {cameraStarting ? 'Cancel hands-free' : 'Stop hands-free'}</button>
                : <button className="button button-secondary handsfree-home-toggle" onClick={() => void startCamera()}><Hand size={15} /> Enable hands-free</button>}
              <span className="hero-meta"><span className={'status-dot ' + (cameraOn ? 'active' : '')} /> {cameraOn ? (handCount ? 'HAND CONTROL READY' : 'SHOW YOUR HAND') : '4 EXPERIENCES'} <span className="meta-divider">/</span> CAMERA OPTIONAL</span>
            </div>
            {(cameraOn || cameraStarting || cameraStatus !== 'Camera is off') && <div className={'handsfree-home-status' + (cameraOn ? ' is-active' : ' is-warning')}><span className={'status-dot' + (cameraOn ? ' active' : '')} /> {cameraOn ? (handCount > 0 ? 'Hand detected · pinch a highlighted control to activate it' : 'Hands-free is on · move your hand fully into the camera view') : cameraStarting ? 'Starting hands-free tracking…' : cameraStatus}</div>}
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

      <div ref={globalGestureCursorRef} className="global-gesture-cursor" aria-hidden="true"><span /><i /></div>
      {showHelp && <div className="modal-backdrop" role="presentation" onClick={() => setShowHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setShowHelp(false)} aria-label="Close help"><X size={18} /></button><div className="modal-icon"><CircleHelp size={22} /></div><div className="eyebrow">QUICK GUIDE</div><h2 id="help-title">Welcome to Nexus.</h2><p>Nexus is an experimental playground for camera-based interaction. You can enable hands-free navigation directly from Home, or enter an experience first. Move your hand until the reticle highlights a control, pinch once to activate it, and release before the next click. The camera stays off until you opt in. Switch themes using the sun/moon button in the top bar.</p><div className="help-list"><div><Camera size={16} /><span><strong>Camera access</strong><small>Requested only when you press Enable camera. Use HTTPS or localhost.</small></span></div><div><ShieldCheck size={16} /><span><strong>Privacy</strong><small>Video is processed in your browser and is not uploaded by this app.</small></span></div><div><Maximize2 size={16} /><span><strong>Good tracking</strong><small>Use bright, even light and keep your hand fully visible.</small></span></div><div><Move3D size={16} /><span><strong>Scroll the whole app</strong><small>Make a fist and move your hand up or down to scroll the page or the scrollable panel under your cursor. Open your hand to stop scrolling; pinch still activates controls.</small></span></div><div><Hand size={16} /><span><strong>Hands-free Home</strong><small>Enable hands-free in Home, then pinch a highlighted experience card to open it. Returning Home can keep your opted-in session active.</small></span></div><div><Hand size={16} /><span><strong>HoloDesk & AirOS</strong><small>In HoloDesk and RealityScan, move your hand to move the on-screen reticle; a highlighted button can be activated with one pinch. In HoloDesk, pinch over the hologram to grab it. In AirOS, pinch any highlighted button to activate it or pinch and hold a window title to move the window. Release fully before the next click.</small></span></div><div><Target size={16} /><span><strong>ShadowStrike</strong><small>Move your body to steer, raise a hand to strike, and jump to dodge. Keep your full body in view.</small></span></div><div><ScanLine size={16} /><span><strong>RealityScan Live</strong><small>Point the camera at everyday objects. Use the hand reticle to pinch visible Nexus controls; the object detector itself labels items in the camera view.</small></span></div></div><button className="button button-primary modal-done" onClick={() => setShowHelp(false)}>Got it <Check size={16} /></button></section></div>}
    </main>
  );
}
