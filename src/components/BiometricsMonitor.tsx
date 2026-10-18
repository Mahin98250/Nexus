import { useEffect, useRef, useState, type RefObject } from 'react';
import type { HandInputRef } from '../vision/types';
import { Activity, AlertTriangle, Camera, Download, HeartPulse, ScanFace, ShieldCheck, Trash2, Waves } from 'lucide-react';

type Props = { cameraEnabled: boolean; videoRef: RefObject<HTMLVideoElement>; handInputRef: HandInputRef };
type Sample = { at: number; r: number; g: number; b: number };
type PulseEstimate = { bpm: number; confidence: number; quality: 'low' | 'fair' | 'good' };
type SignalMetrics = { variability: number | null; stability: number | null; redMean: number; greenMean: number; blueMean: number; sampleRate: number; motion: 'low' | 'moderate' | 'high' };
type EmotionResult = { dominant_emotion: string; emotion_scores: Record<string, number>; face_confidence: number | null; model: string };
type FaceBox = { x: number; y: number; width: number; height: number };
type CheckInEntry = { at: string; focus: number; load: number; mood: string; pulseBpm: number | null; signalQuality: string; stability: number | null; sampleRateHz: number };
type FaceDetectorLike = { detect: (source: CanvasImageSource) => Promise<Array<{ boundingBox: DOMRectReadOnly }>>; close?: () => void };
type FaceDetectorConstructor = new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => FaceDetectorLike;

const SAMPLE_WINDOW_MS = 12_000;
const MIN_SIGNAL_MS = 8_000;
const MIN_SAMPLES = 100;
const MIN_BPM = 48;
const MAX_BPM = 180;

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Descriptive statistics for the sampled RGB stream; not a diagnosis or emotion model. */
function analyzeSignal(samples: Sample[], motion: number): SignalMetrics {
  const recent = samples.slice(-120);
  const green = recent.map((sample) => sample.g);
  const intervals = recent.slice(1).map((sample, index) => sample.at - recent[index].at).filter((value) => value > 0);
  const greenMean = mean(green);
  const variability = green.length > 8
    ? Math.sqrt(mean(green.map((value) => (value - greenMean) ** 2)))
    : null;
  const normalizedSpread = variability === null ? null : variability / Math.max(greenMean, 1);
  const stability = normalizedSpread === null ? null : Math.max(0, Math.min(100, 100 - normalizedSpread * 900));
  return {
    variability,
    stability,
    redMean: mean(recent.map((sample) => sample.r)),
    greenMean,
    blueMean: mean(recent.map((sample) => sample.b)),
    sampleRate: intervals.length ? 1000 / mean(intervals) : 0,
    motion: motion > 0.035 ? 'high' : motion > 0.012 ? 'moderate' : 'low',
  };
}

/** Experimental rPPG baseline. Never treat this as a clinically validated measurement. */
function estimatePulse(samples: Sample[]): PulseEstimate | null {
  if (samples.length < MIN_SAMPLES || samples[samples.length - 1].at - samples[0].at < MIN_SIGNAL_MS) return null;
  const interval = mean(samples.slice(1).map((sample, index) => sample.at - samples[index].at));
  if (!Number.isFinite(interval) || interval <= 0) return null;
  const hz = 1000 / interval;
  if (hz < 10) return null;

  const green = samples.map((sample) => sample.g);
  const signal = green.map((value, index) => value - mean(green.slice(Math.max(0, index - 4), Math.min(green.length, index + 5))));
  const center = mean(signal);
  for (let index = 0; index < signal.length; index += 1) {
    signal[index] = (signal[index] - center) * (0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (signal.length - 1)));
  }

  const powers: Array<{ frequency: number; power: number }> = [];
  const step = hz / signal.length / 2;
  for (let frequency = Math.max(0.8, MIN_BPM / 60); frequency <= Math.min(3, MAX_BPM / 60, hz / 2); frequency += step) {
    let real = 0, imaginary = 0;
    const omega = 2 * Math.PI * frequency / hz;
    for (let index = 0; index < signal.length; index += 1) {
      real += signal[index] * Math.cos(omega * index);
      imaginary -= signal[index] * Math.sin(omega * index);
    }
    powers.push({ frequency, power: real * real + imaginary * imaginary });
  }
  powers.sort((a, b) => b.power - a.power);
  const strongest = powers[0];
  if (!strongest || strongest.power <= 0) return null;
  const totalPower = powers.reduce((sum, item) => sum + item.power, 0);
  const confidence = totalPower > 0 ? Math.min(0.99, strongest.power / totalPower * 5) : 0;
  const bpm = Math.round(strongest.frequency * 60);
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) return null;
  return { bpm, confidence, quality: confidence >= 0.22 ? 'good' : confidence >= 0.1 ? 'fair' : 'low' };
}

export default function BiometricsMonitor({ cameraEnabled, videoRef, handInputRef }: Props) {
  const [focus, setFocus] = useState(50);
  const [load, setLoad] = useState(35);
  const [running, setRunning] = useState(false);
  const [signals, setSignals] = useState<Sample[]>([]);
  const [pulse, setPulse] = useState<PulseEstimate | null>(null);
  const [quality, setQuality] = useState<'waiting' | 'face-area' | 'lighting' | 'collecting' | 'low-fps' | 'ready'>('waiting');
  const [signalLevel, setSignalLevel] = useState(0);
  const [signalMetrics, setSignalMetrics] = useState<SignalMetrics>({ variability: null, stability: null, redMean: 0, greenMean: 0, blueMean: 0, sampleRate: 0, motion: 'low' });
  const [showResearchPanel, setShowResearchPanel] = useState(true);
  const [emotionEndpoint, setEmotionEndpoint] = useState('http://127.0.0.1:8000');
  const [emotionEnabled, setEmotionEnabled] = useState(false);
  const [emotionLoading, setEmotionLoading] = useState(false);
  const [emotionResult, setEmotionResult] = useState<EmotionResult | null>(null);
  const [emotionError, setEmotionError] = useState('');
  const [emotionApiStatus, setEmotionApiStatus] = useState<'untested' | 'checking' | 'online' | 'offline'>('untested');
  const emotionRequestRef = useRef(false);
  const [faceTracking, setFaceTracking] = useState<'native' | 'fallback' | 'unavailable'>('fallback');
  const [faceFrame, setFaceFrame] = useState({ x: 0.28, y: 0.14, width: 0.44, height: 0.58 });
  const [notes, setNotes] = useState('Sit still, face the camera, and use steady, bright light.');
  const [mode, setMode] = useState<'signals' | 'checkin'>('signals');
  const [showGestureGuide, setShowGestureGuide] = useState(false);
  const [mood, setMood] = useState('Neutral');
  const [checkInHistory, setCheckInHistory] = useState<CheckInEntry[]>([]);
  const [historyMessage, setHistoryMessage] = useState('');
  const [gestureHint, setGestureHint] = useState('Move your hand pointer over a slider and pinch to adjust it.');
  const previousPinchRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<Sample[]>([]);
  const frameRef = useRef<number | null>(null);
  const lastSampleAtRef = useRef(0);
  const lastUiAtRef = useRef(0);
  const lastMotionRef = useRef<{ x: number; y: number } | null>(null);
  const paused = !cameraEnabled || !running;

  // Turning the camera off always revokes the classifier's active consent session.
  useEffect(() => {
    if (!cameraEnabled) {
      setEmotionEnabled(false);
      setEmotionResult(null);
      setEmotionError('');
      setEmotionApiStatus('untested');
    }
  }, [cameraEnabled]);

  // Pinch-and-move directly adjusts VitalSense sliders; shared Nexus controls handle button clicks.
  useEffect(() => {
    if (!cameraEnabled) {
      previousPinchRef.current = false;
      return;
    }
    let frame = 0;
    let lastUi = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const hand = handInputRef.current;
      if (!hand.detected) {
        previousPinchRef.current = false;
        return;
      }
      const x = Math.max(0, Math.min(1, hand.x));
      const y = Math.max(0, Math.min(1, hand.y));
      const target = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight);
      const slider = target instanceof HTMLInputElement && target.type === 'range' && target.closest('.biometrics-layout') ? target : null;
      if (hand.pinch && slider) {
        const rect = slider.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (x * window.innerWidth - rect.left) / Math.max(rect.width, 1)));
        const min = Number(slider.min || 0), max = Number(slider.max || 100), step = Number(slider.step || 1);
        const next = Math.max(min, Math.min(max, min + Math.round((ratio * (max - min)) / step) * step));
        if (now - lastUi > 35 && Number(slider.value) !== next) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(slider, String(next));
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          slider.dispatchEvent(new Event('change', { bubbles: true }));
          lastUi = now;
          setGestureHint('Adjusting ' + (slider.id === 'bio-focus' ? 'focus' : slider.id === 'bio-load' ? 'mental load' : 'control') + ' · ' + next + '%');
        }
      } else if (hand.pinch && !previousPinchRef.current && target instanceof HTMLElement && target.closest('.biometrics-layout button')) {
        setGestureHint('Pinch recognized · activating control');
      } else if (!hand.pinch && previousPinchRef.current) {
        setGestureHint('Gesture released · ready for next action');
      }
      previousPinchRef.current = hand.pinch;
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); previousPinchRef.current = false; };
  }, [cameraEnabled, handInputRef]);

  useEffect(() => {
    samplesRef.current = [];
    setSignals([]);
    setPulse(null);
    setQuality('waiting');
    setSignalLevel(0);
    setRunning(false);
  }, [cameraEnabled]);

  useEffect(() => {
    if (paused) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      return;
    }

    let disposed = false;
    let detector: FaceDetectorLike | null = null;
    try {
      const Detector = (window as Window & { FaceDetector?: FaceDetectorConstructor }).FaceDetector;
      if (Detector) { detector = new Detector({ fastMode: true, maxDetectedFaces: 1 }); setFaceTracking('native'); }
      else setFaceTracking('fallback');
    } catch { detector = null; setFaceTracking('fallback'); }
    let detectionInFlight = false;
    let frameCount = 0;
    let faceBox: FaceBox | null = null;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d', { willReadFrequently: true }) ?? null;

    const loop = (now: number) => {
      if (disposed) return;
      frameRef.current = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 1 || !canvas || !context) return;
      const width = 160, height = 120;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.drawImage(video, 0, 0, width, height);
      frameCount += 1;

      if (detector && !detectionInFlight && frameCount % 8 === 0) {
        detectionInFlight = true;
        void detector.detect(canvas).then((faces) => {
          if (disposed) return;
          if (!faces[0]) { faceBox = null; return; }
          const box = faces[0].boundingBox;
          const nx = box.x / width, ny = box.y / height;
          const nw = box.width / width, nh = box.height / height;
          if (nw > 0.12 && nh > 0.14 && nx >= 0 && ny >= 0 && nx + nw <= 1 && ny + nh <= 1) {
            faceBox = faceBox
              ? { x: faceBox.x * 0.7 + nx * 0.3, y: faceBox.y * 0.7 + ny * 0.3, width: faceBox.width * 0.7 + nw * 0.3, height: faceBox.height * 0.7 + nh * 0.3 }
              : { x: nx, y: ny, width: nw, height: nh };
          } else faceBox = null;
        }).catch(() => { detector = null; }).finally(() => { detectionInFlight = false; });
      }
      if (frameCount % 8 === 0) {
        setFaceFrame(faceBox ?? { x: 0.28, y: 0.14, width: 0.44, height: 0.58 });
        if (detector && faceBox) setFaceTracking('native');
      }

      if (now - lastSampleAtRef.current < 75) return;
      lastSampleAtRef.current = now;
      const box = faceBox ?? { x: 0.28, y: 0.14, width: 0.44, height: 0.58 };
      const left = Math.max(0, Math.floor((box.x + box.width * 0.2) * width));
      const right = Math.min(width, Math.ceil((box.x + box.width * 0.8) * width));
      const top = Math.max(0, Math.floor((box.y + box.height * 0.22) * height));
      const bottom = Math.min(height, Math.ceil((box.y + box.height * 0.54) * height));
      if (right <= left || bottom <= top) { setQuality('face-area'); return; }
      const pixels = context.getImageData(left, top, right - left, bottom - top).data;
      let red = 0, green = 0, blue = 0, count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        red += pixels[index]; green += pixels[index + 1]; blue += pixels[index + 2]; count += 1;
      }
      if (!count) { setQuality('lighting'); return; }
      const sample = { at: now, r: red / count, g: green / count, b: blue / count };
      const next = [...samplesRef.current, sample].filter((item) => now - item.at <= SAMPLE_WINDOW_MS);
      samplesRef.current = next;
      const brightness = (sample.r + sample.g + sample.b) / 3;
      const spread = Math.max(sample.r, sample.g, sample.b) - Math.min(sample.r, sample.g, sample.b);
      const prior = lastMotionRef.current;
      const movement = prior ? Math.hypot(box.x - prior.x, box.y - prior.y) : 0;
      lastMotionRef.current = { x: box.x, y: box.y };
      if (now - lastUiAtRef.current < 350) return;
      lastUiAtRef.current = now;
      setSignalLevel(Math.max(0, Math.min(100, (brightness - 20) / 1.6)));
      setSignals(next);
      setSignalMetrics(analyzeSignal(next, movement));
      if (brightness < 35 || brightness > 235 || spread < 5) {
        setQuality('lighting'); setNotes('Lighting is too dim, washed out, or unstable for a useful signal.'); setPulse(null);
      } else if (movement > 0.035) {
        setQuality('face-area'); setNotes('Face movement is high; stay still to reduce motion artefacts.'); setPulse(null);
      } else if (now - (next[0]?.at ?? now) < MIN_SIGNAL_MS) {
        setQuality('collecting'); setNotes('Collecting signal — keep your face steady.'); setPulse(null);
      } else {
        const estimate = estimatePulse(next);
        setPulse(estimate);
        setQuality(estimate ? 'ready' : 'low-fps');
        setNotes(estimate ? 'A pulse candidate was found. Validate it against a reference sensor.' : 'Signal is weak or inconsistent. Hold still and improve lighting.');
      }
    };
    frameRef.current = requestAnimationFrame(loop);
    return () => {
      disposed = true;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      detector?.close?.();
    };
  }, [paused, videoRef]);


  const testEmotionApi = async () => {
    let cancelledEndpoint: URL;
    try {
      cancelledEndpoint = new URL(emotionEndpoint.trim());
      if (!['http:', 'https:'].includes(cancelledEndpoint.protocol)) throw new Error('Use an http:// or https:// API endpoint.');
    } catch (error) {
      setEmotionApiStatus('offline');
      setEmotionError(error instanceof Error ? error.message : 'Enter a valid API endpoint.');
      return;
    }
    setEmotionApiStatus('checking');
    setEmotionError('');
    try {
      const response = await fetch(cancelledEndpoint.toString().replace(/\/+$/, '') + '/health', { method: 'GET' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.status !== 'ok') throw new Error('API health check failed. Start the DeepFace service and check its CORS settings.');
      setEmotionApiStatus('online');
    } catch {
      setEmotionApiStatus('offline');
      setEmotionError('Cannot reach the DeepFace API. Start services/deepface locally or enter a reachable HTTPS API URL. GitHub Pages does not host the Python model.');
    }
  };

  // Emotion analysis is strictly opt-in. Frames are sent only to the endpoint the user configures.
  useEffect(() => {
    if (!cameraEnabled || !emotionEnabled) return;
    let cancelled = false;
    const analyzeFrame = async () => {
      if (cancelled || emotionRequestRef.current) return;
      const video = videoRef.current;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 1) return;
      emotionRequestRef.current = true;
      setEmotionLoading(true);
      setEmotionError('');
      try {
        const url = new URL(emotionEndpoint.trim());
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http:// or https:// API endpoint.');
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 640 / video.videoWidth, 480 / video.videoHeight);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not prepare a camera frame.');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
        if (!blob) throw new Error('Could not encode a camera frame.');
        const form = new FormData();
        form.append('image', blob, 'vitalsense-frame.jpg');
        const apiBase = url.toString().replace(/\/+$/, '');
        const response = await fetch(apiBase + '/analyze', { method: 'POST', body: form });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'Classifier request failed (' + response.status + ').');
        if (!payload || typeof payload.dominant_emotion !== 'string' || !payload.emotion_scores) throw new Error('The API response did not match the expected DeepFace format.');
        if (!cancelled) setEmotionResult(payload as EmotionResult);
      } catch (error) {
        if (!cancelled) setEmotionError(error instanceof Error ? error.message : 'Unable to reach the classifier API.');
      } finally {
        emotionRequestRef.current = false;
        if (!cancelled) setEmotionLoading(false);
      }
    };
    void analyzeFrame();
    const timer = window.setInterval(() => { void analyzeFrame(); }, 2500);
    return () => { cancelled = true; window.clearInterval(timer); emotionRequestRef.current = false; setEmotionLoading(false); };
  }, [cameraEnabled, emotionEnabled, emotionEndpoint, videoRef]);

  const saveCheckIn = () => {
    const entry: CheckInEntry = {
      at: new Date().toISOString(),
      focus,
      load,
      mood,
      pulseBpm: pulse?.bpm ?? null,
      signalQuality: pulse?.quality ?? 'not-ready',
      stability: signalMetrics.stability,
      sampleRateHz: Number(signalMetrics.sampleRate.toFixed(2)),
    };
    setCheckInHistory((history) => [...history, entry].slice(-100));
    setHistoryMessage('Check-in added to this session only.');
  };

  const exportCheckIns = () => {
    if (!checkInHistory.length) return;
    const columns: Array<keyof CheckInEntry> = ['at', 'focus', 'load', 'mood', 'pulseBpm', 'signalQuality', 'stability', 'sampleRateHz'];
    const escapeCsv = (value: string | number | null) => {
      const text = value === null ? '' : String(value);
      return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const csv = [columns.join(','), ...checkInHistory.map((entry) => columns.map((column) => escapeCsv(entry[column])).join(','))].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'vitalsense-session-checkins.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    setHistoryMessage('CSV export prepared from the check-ins in this session.');
  };

  const clearCheckIns = () => {
    setCheckInHistory([]);
    setHistoryMessage('Session check-in history cleared.');
  };

  const statusText = {
    waiting: 'READY WHEN YOU ARE', 'face-area': 'CHECK FACE POSITION / MOTION',
    lighting: 'CHECK LIGHTING', collecting: 'COLLECTING SIGNAL',
    'low-fps': 'SIGNAL TOO WEAK', ready: 'EXPERIMENTAL ESTIMATE',
  } as const;

  return (
    <div className="biometrics-layout">
      <canvas ref={canvasRef} className="biometrics-hidden-canvas" aria-hidden="true" />
      <div className="biometrics-main">
        <div className="biometrics-banner">
          <div><span className="bio-eyebrow"><Activity size={14} /> SIGNAL LAB / BROWSER-LOCAL</span><h2>Physiology, with context.</h2><p>Explore camera color signals and attention self-checks. These are estimates, not diagnoses.</p></div>
          <span className={'bio-status ' + quality}><span className="status-dot" />{statusText[quality]}</span>
        </div>
        <div className="bio-modebar" role="tablist" aria-label="VitalSense modes">
          <button role="tab" aria-selected={mode === 'signals'} className={mode === 'signals' ? 'is-active' : ''} onClick={() => setMode('signals')}>01 · Signal monitor</button>
          <button role="tab" aria-selected={mode === 'checkin'} className={mode === 'checkin' ? 'is-active' : ''} onClick={() => setMode('checkin')}>02 · Cognitive check-in</button>
          <button className="bio-manual-trigger" onClick={() => setShowGestureGuide((value) => !value)}>{showGestureGuide ? 'Hide gesture manual' : 'Gesture manual'}</button>
        </div>
        {showGestureGuide && <section className="bio-gesture-manual" aria-label="VitalSense gesture manual">
          <strong>VITALSENSE · HAND CONTROLS</strong>
          <p><b>Move open hand:</b> move the pointer. <b>Pinch and release:</b> activate a highlighted button once. <b>Pinch and move over a slider:</b> adjust focus or mental-load values. <b>Open your fingers:</b> release the control.</p>
          <p>Enable the camera first. Keep the hand visible and use slow movements. Keyboard, mouse, and touch remain available.</p>
        </section>}
        {cameraEnabled && <div className="bio-gesture-feedback"><span className={handInputRef.current.detected ? 'status-dot active' : 'status-dot'} /> {gestureHint}</div>}
        {!cameraEnabled && <div className="bio-callout"><Camera size={18} /><div><strong>Camera is off</strong><span>Enable the camera using the control above. Nothing starts automatically.</span></div></div>}
        {cameraEnabled && <div className="bio-consent-note"><ShieldCheck size={15} /> Camera frames are sampled in this tab. Raw video and samples are not saved or uploaded.</div>}
        {cameraEnabled && <div className="bio-controls"><button className="button button-primary" onClick={() => setRunning((value) => !value)}>{running ? 'Pause signal sampling' : 'Start signal sampling'}</button><span>Sampling is off until you start it.</span></div>}
        <div className={"biometrics-grid " + (mode === "checkin" ? "bio-checkin-mode" : "bio-signals-mode")}>
          <section className="bio-panel bio-pulse-panel">
            <div className="bio-panel-top"><span><HeartPulse size={15} /> rPPG / PULSE</span><span>RGB · SPECTRUM CANDIDATE</span></div>
            <div className="bio-face-preview">
              {cameraEnabled && <video className="bio-video-mirror" ref={(node) => { const source = videoRef.current; if (node && source && source.srcObject) node.srcObject = source.srcObject; }} muted playsInline autoPlay aria-label="Mirrored camera preview" />}
              <div className="bio-face-guide" style={{ left: (faceFrame.x * 100) + '%', top: (faceFrame.y * 100) + '%', width: (faceFrame.width * 100) + '%', height: (faceFrame.height * 100) + '%' }}><span>FACE ROI</span></div>
              {!cameraEnabled && <div className="bio-preview-placeholder"><Camera size={24} /><span>Camera preview appears after opt-in</span></div>}
            </div>
            <div className="bio-heart-metric"><div><span className="field-label">ESTIMATED PULSE</span><div className="bio-bpm">{pulse ? pulse.bpm : '—'} <small>BPM</small></div></div><div className="bio-confidence"><span className="field-label">SIGNAL QUALITY</span><strong className={pulse?.quality ?? 'low'}>{pulse ? pulse.quality.toUpperCase() : 'NOT READY'}</strong><span>{signals.length} samples</span></div></div>
            <div className="bio-signal-bars"><span>CAMERA LIGHT</span><div><i style={{ width: signalLevel + '%' }} /></div></div>
            <div className="bio-trace" aria-label="Live camera color signal">{Array.from({ length: 42 }, (_, index) => { const windowed = signals.slice(-42); const sample = windowed[index]; const baseline = windowed.length ? mean(windowed.map((item) => item.g)) : 128; const height = sample ? 7 + Math.min(25, Math.abs(sample.g - baseline) * 1.8) : 3; return <i key={index} style={{ height: height + 'px', opacity: sample ? 0.9 : 0.18 }} />; })}</div>
            <p className="bio-signal-note">{notes}</p>
            <p className="bio-disclaimer"><AlertTriangle size={14} /> Experimental rPPG estimate only. Lighting, motion, camera processing and skin tone can distort readings. Do not use this for medical decisions.</p>
          </section>
          <section className="bio-panel">
            <div className="bio-panel-top"><span><Waves size={15} /> COGNITIVE CHECK-IN</span><span>SELF-REPORTED</span></div>
            <p className="bio-explainer">A webcam cannot reliably tell you how focused or stressed you feel. Record your own state to compare with the camera signal during an experiment.</p>
            <div className="bio-self-report"><label htmlFor="bio-focus">How focused do you feel?</label><input id="bio-focus" type="range" min="0" max="100" value={focus} onChange={(event) => setFocus(Number(event.currentTarget.value))} /><div><span>Scattered</span><strong>{focus}/100</strong><span>Focused</span></div><label htmlFor="bio-load">How mentally loaded do you feel?</label><input id="bio-load" type="range" min="0" max="100" value={load} onChange={(event) => setLoad(Number(event.currentTarget.value))} /><div><span>Light</span><strong>{load}/100</strong><span>Heavy</span></div></div>
            <label className="bio-mood-label" htmlFor="bio-mood">How would you describe your current mood? (self-reported)</label>
            <select id="bio-mood" value={mood} onChange={(event) => setMood(event.currentTarget.value)}><option>Neutral</option><option>Calm</option><option>Positive</option><option>Tired</option><option>Overwhelmed</option><option>Low</option></select>
            <div className="bio-summary-grid"><div><span>FOCUS · YOUR INPUT</span><strong>{focus}%</strong></div><div><span>LOAD · YOUR INPUT</span><strong>{load}%</strong></div></div>
            <div className="bio-checkin-actions">
              <button className="button button-primary" onClick={saveCheckIn}>Save check-in to session</button>
              <button className="button button-secondary" disabled={!checkInHistory.length} onClick={exportCheckIns}><Download size={14} /> Export CSV ({checkInHistory.length})</button>
              <button className="button button-secondary" disabled={!checkInHistory.length} onClick={clearCheckIns}><Trash2 size={14} /> Clear</button>
            </div>
            {historyMessage && <p className="bio-history-message" role="status">{historyMessage}</p>}
            {checkInHistory.length > 0 && <div className="bio-checkin-history" aria-label="Current session check-in history">
              <div className="bio-history-heading"><strong>SESSION HISTORY</strong><span>Newest first · max 100 entries</span></div>
              {[...checkInHistory].reverse().slice(0, 5).map((entry) => <div className="bio-history-row" key={entry.at}>
                <span>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <span>Focus <b>{entry.focus}%</b></span>
                <span>Load <b>{entry.load}%</b></span>
                <span>{entry.mood}</span>
                <span>{entry.pulseBpm === null ? 'Pulse —' : 'Pulse ' + entry.pulseBpm + ' BPM'}</span>
              </div>)}
            </div>}
            <p className="bio-disclaimer"><ShieldCheck size={14} /> Focus, mental load, and mood are your own check-ins. History stays in this page's memory until you clear it or leave; export is an explicit local download.</p>
          </section>
        </div>
        <section className="bio-research-panel">
          <button className="bio-research-toggle" aria-expanded={showResearchPanel} onClick={() => setShowResearchPanel((value) => !value)}><span><ScanFace size={16} /> ADVANCED SIGNAL ANALYSIS / RESEARCH VIEW</span><span>{showResearchPanel ? 'Hide details −' : 'Show details +'}</span></button>
          {showResearchPanel && <div className="bio-research-content">
            <p className="bio-explainer">Live descriptive features calculated from camera RGB samples. These are signal diagnostics, not an objective emotion, stress, or cognitive-load classifier.</p>
            <div className="bio-research-grid">
              <div><span>GREEN CHANNEL VARIABILITY</span><strong>{signalMetrics.variability === null ? '—' : signalMetrics.variability.toFixed(2)}</strong><small>Standard deviation · intensity units</small></div>
              <div><span>SHORT-WINDOW STABILITY</span><strong>{signalMetrics.stability === null ? '—' : Math.round(signalMetrics.stability) + '%'}</strong><small>Heuristic signal-quality indicator</small></div>
              <div><span>SAMPLE RATE</span><strong>{signalMetrics.sampleRate ? signalMetrics.sampleRate.toFixed(1) + ' Hz' : '—'}</strong><small>Actual camera sample timestamps</small></div>
              <div><span>FACE / MOTION STATUS</span><strong>{signalMetrics.motion.toUpperCase()}</strong><small>{faceTracking === 'native' ? 'Browser FaceDetector available' : faceTracking === 'fallback' ? 'Center-region fallback; face not verified' : 'Face detection unavailable'}</small></div>
            </div>
            <div className="bio-rgb-strip"><span>MEAN RGB INTENSITY</span><div><i style={{ width: Math.min(100, signalMetrics.redMean / 255 * 100) + '%', background: '#f0808b' }} /><b>R {signalMetrics.redMean ? Math.round(signalMetrics.redMean) : '—'}</b></div><div><i style={{ width: Math.min(100, signalMetrics.greenMean / 255 * 100) + '%', background: '#78d6a4' }} /><b>G {signalMetrics.greenMean ? Math.round(signalMetrics.greenMean) : '—'}</b></div><div><i style={{ width: Math.min(100, signalMetrics.blueMean / 255 * 100) + '%', background: '#80aaff' }} /><b>B {signalMetrics.blueMean ? Math.round(signalMetrics.blueMean) : '—'}</b></div></div>

            <div className="bio-method-note bio-emotion-module">
              <div className="bio-emotion-heading"><strong><ScanFace size={15} /> DEEPFACE · EXPRESSION CLASSIFIER</strong><span className={emotionEnabled ? 'bio-emotion-state active' : 'bio-emotion-state'}>{emotionEnabled ? 'RUNNING' : 'OFF'}</span></div>
              <p>Optional frame-by-frame facial-expression estimates using the local DeepFace API. This is not a validated micro-expression detector, and labels are not proof of a person's internal emotion.</p>
              <label className="bio-mood-label" htmlFor="bio-emotion-endpoint">Classifier API endpoint</label>
              <input id="bio-emotion-endpoint" className="bio-emotion-endpoint" value={emotionEndpoint} onChange={(event) => setEmotionEndpoint(event.currentTarget.value)} disabled={emotionEnabled} spellCheck={false} />
              <div className="bio-emotion-actions">
                <button className="button button-secondary" disabled={emotionApiStatus === 'checking'} onClick={() => void testEmotionApi()}>{emotionApiStatus === 'checking' ? 'Testing API…' : 'Test API connection'}</button>
                <span className={'bio-emotion-state ' + (emotionApiStatus === 'online' ? 'active' : '')}>{emotionApiStatus === 'online' ? 'API ONLINE' : emotionApiStatus === 'offline' ? 'API OFFLINE' : 'API NOT TESTED'}</span>
                <button className="button button-primary" disabled={!cameraEnabled || (emotionLoading && !emotionEnabled)} onClick={() => { setEmotionError(''); setEmotionResult(null); setEmotionEnabled((value) => !value); }}>{emotionEnabled ? 'Stop classifier' : 'I consent · Start expression analysis'}</button>
                {emotionLoading && <span>Analyzing frame…</span>}
              </div>
              <p className="bio-emotion-message">The public GitHub Pages site does not run Python inference. For local testing, start the included DeepFace API on this computer; for public use, configure a trusted HTTPS API endpoint.</p>
              {!cameraEnabled && <p className="bio-emotion-message">Enable the camera before starting expression analysis.</p>}
              {emotionError && <p className="bio-emotion-error" role="alert">{emotionError} Check that the API is running and allows this website in its CORS settings.</p>}
              {emotionResult && <div className="bio-emotion-result" aria-live="polite">
                <div><span>DOMINANT LABEL · MODEL OUTPUT</span><strong>{emotionResult.dominant_emotion}</strong><small>{emotionResult.model || 'DeepFace'} · face confidence {typeof emotionResult.face_confidence === 'number' ? Math.round(emotionResult.face_confidence * 100) + '%' : 'not supplied'}</small></div>
                <div className="bio-emotion-scores">{Object.entries(emotionResult.emotion_scores).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([label, score]) => <div key={label}><span>{label}</span><div><i style={{ width: Math.max(0, Math.min(100, score)) + '%' }} /></div><b>{Math.round(score)}%</b></div>)}</div>
              </div>}
              <p className="bio-disclaimer"><ShieldCheck size={14} /> Explicit opt-in required. When running, still frames are sent about every 2.5 seconds to the endpoint above. The included backend processes frames in memory and does not save them. Do not use this for diagnosis, hiring, discipline, or consequential decisions.</p>
            </div>
            <div className="bio-method-note"><strong>Stress / cognitive load</strong><p>Not inferred from video. rPPG variability and face motion are affected by illumination, movement, camera auto-exposure, and environment. Use the cognitive check-in to record your own focus and load.</p></div>
          </div>}
        </section>
        <div className="bio-limits"><strong><AlertTriangle size={15} /> What this can and cannot do</strong><p>This demo visualizes camera signal quality, descriptive RGB features, face-region/motion status, and an experimental pulse candidate. It does not detect stress, diagnose a condition, or infer emotion, truthfulness, or cognitive ability from facial movements.</p></div>
      </div>
    </div>
  );
}
