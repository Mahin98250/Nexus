import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Camera, Check, ChevronRight, CircleHelp, Command,
  Hand, Layers3, Maximize2, Monitor, Move3D, Play, ScanLine,
  Settings2, ShieldCheck, Sparkles, Target, X,
} from 'lucide-react';
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import ShadowStrikeGame from './components/ShadowStrikeGame';
import AirOSDesktop from './components/AirOSDesktop';
import RealityScanOverlay from './components/RealityScanOverlay';
import HoloDeskScene from './components/HoloDeskScene';
import { deriveHandInput } from './vision/gestures';
import { deriveBodyInput } from './vision/bodyGestures';
import { getRuntimeErrorDetails } from './vision/runtimeErrors';
import { EMPTY_BODY_INPUT, EMPTY_HAND_INPUT, type BodyInput, type HandInput } from './vision/types';

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

const visionWasmCandidates = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm',
  'https://unpkg.com/@mediapipe/tasks-vision@0.10.22/wasm',
];
// Some mobile networks can load the camera but block or interrupt Google Cloud Storage.
// Keep a second model mirror so camera permission success is not mistaken for model success.
const handModelCandidates = [
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'https://github.com/sanderdesnaijer/mediapipe-model-mirrors/releases/download/v1/hand_landmarker.task',
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
  const handInputRef = useRef<HandInput>({ ...EMPTY_HAND_INPUT });
  const bodyInputRef = useRef<BodyInput>({ ...EMPTY_BODY_INPUT });
  const videoRef = useRef<HTMLVideoElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const cameraSessionRef = useRef(0);
  const cameraStartingRef = useRef(false);
  const lastFrameRef = useRef(0);
  const lastVisionFrameRef = useRef(0);
  const frameCountRef = useRef(0);
  const activeExperience = experiences.find((item) => item.id === active) ?? null;

  const stopCamera = useCallback(() => {
    cameraSessionRef.current += 1;
    cameraStartingRef.current = false;
    setCameraStarting(false);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
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
        let monitorLastFrame = 0;
        let monitorFrames = 0;
        const monitor = (now: number) => {
          if (sessionId !== cameraSessionRef.current) return;
          frameRef.current = requestAnimationFrame(monitor);
          monitorFrames += 1;
          if (now - monitorLastFrame >= 1000) {
            setFps(monitorFrames);
            monitorFrames = 0;
            monitorLastFrame = now;
          }
        };
        frameRef.current = requestAnimationFrame(monitor);
        return;
      }

      setCameraStatus(active === 'shadowstrike' ? 'Loading pose-tracking model…' : 'Loading hand-tracking model…');
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
        throw new Error(`MediaPipe runtime files failed to load from both CDNs (${details.name ? details.name + ': ' : ''}${details.message}). Check the connection or content blocker and retry.`);
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
        let landmarker: HandLandmarker | null = null;
        let handModelError: unknown = null;
        // Try each model source with GPU and CPU. Changing delegate alone cannot
        // recover when the model download itself is blocked or returns an error event.
        for (const modelAssetPath of handModelCandidates) {
          for (const delegate of ['GPU', 'CPU'] as const) {
            try {
              landmarker = await HandLandmarker.createFromOptions(vision, {
                ...trackingOptions,
                baseOptions: { modelAssetPath, delegate },
              });
              break;
            } catch (error) {
              handModelError = error;
            }
          }
          if (landmarker) break;
        }
        if (!landmarker) {
          const details = getRuntimeErrorDetails(handModelError);
          throw new Error(`Hand model failed from all configured sources (${details.name ? details.name + ': ' : ''}${details.message}). Check whether the network blocks model downloads, then retry.`);
        }
        if (sessionId !== cameraSessionRef.current) {
          landmarker.close();
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        landmarkerRef.current = landmarker;
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
              poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
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
      let consecutiveInferenceErrors = 0;
      const loop = (now: number) => {
        const video = videoRef.current;
        const tracker = landmarkerRef.current;
        const poseTracker = poseLandmarkerRef.current;
        if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          frameRef.current = requestAnimationFrame(loop);
          return;
        }
        // Cap synchronous model inference to roughly 30 frames per second on slower devices.
        if (now - lastVisionFrameRef.current < 33) {
          frameRef.current = requestAnimationFrame(loop);
          return;
        }
        lastVisionFrameRef.current = now;
        let inferenceFailed = false;
        if (tracker) {
          try {
            const result = tracker.detectForVideo(video, now);
            handInputRef.current = deriveHandInput(result.landmarks[0], now, handInputRef.current.pinch);
            setHandCount(result.landmarks.length);
          } catch (error) {
            inferenceFailed = true;
            handInputRef.current = { ...EMPTY_HAND_INPUT };
            setHandCount(0);
            if (consecutiveInferenceErrors === 0) console.warn('Nexus hand-tracking frame failed; retrying.', error);
          }
        } else {
          handInputRef.current = { ...EMPTY_HAND_INPUT };
          setHandCount(0);
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
          consecutiveInferenceErrors += 1;
          if (consecutiveInferenceErrors === 1) setCameraStatus('Tracking hiccup · retrying vision engine…');
          else if (consecutiveInferenceErrors >= 8) setCameraStatus('Tracking unavailable. Check the network and restart the camera.');
        } else {
          consecutiveInferenceErrors = 0;
          setCameraStatus('Vision engine online');
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
    <main className="app-shell">
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
                {activeExperience.id === 'airos' && <AirOSDesktop inputRef={handInputRef} cameraEnabled={cameraOn} />}
                {activeExperience.id === 'realityscan' && <RealityScanOverlay active={cameraOn} videoRef={videoRef} />}
              </div>
              <div className="camera-footer">
                <span className="camera-status"><span className={cameraOn || cameraStarting ? 'status-dot active' : 'status-dot'} /> {cameraStatus}</span>
                <span className="camera-fps">{cameraOn || cameraStarting ? fps + ' FPS · ' + (activeExperience.id === 'shadowstrike' ? (bodyInputRef.current.detected ? 'body tracked' : 'find full body') : activeExperience.id === 'realityscan' ? 'object detector' : handCount + ' hands') : 'NO SIGNAL'}</span>
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

      {showHelp && <div className="modal-backdrop" role="presentation" onClick={() => setShowHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setShowHelp(false)} aria-label="Close help"><X size={18} /></button><div className="modal-icon"><CircleHelp size={22} /></div><div className="eyebrow">QUICK GUIDE</div><h2 id="help-title">Welcome to Nexus.</h2><p>Nexus is an experimental playground for camera-based interaction. Choose an experience to enter its workspace, then enable the camera to test the shared hand-tracking engine.</p><div className="help-list"><div><Camera size={16} /><span><strong>Camera access</strong><small>Requested only when you press Enable camera. Use HTTPS or localhost.</small></span></div><div><ShieldCheck size={16} /><span><strong>Privacy</strong><small>Video is processed in your browser and is not uploaded by this app.</small></span></div><div><Maximize2 size={16} /><span><strong>Good tracking</strong><small>Use bright, even light and keep your hand fully visible.</small></span></div></div><button className="button button-primary modal-done" onClick={() => setShowHelp(false)}>Got it <Check size={16} /></button></section></div>}
    </main>
  );
}
