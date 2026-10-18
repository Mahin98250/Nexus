import { useEffect, useRef, useState, type RefObject } from 'react';
import { Activity, AlertTriangle, Camera, HeartPulse, ShieldCheck, Waves } from 'lucide-react';

type Props = { cameraEnabled: boolean; videoRef: RefObject<HTMLVideoElement> };
type Sample = { at: number; r: number; g: number; b: number };
type PulseEstimate = { bpm: number; confidence: number; quality: 'low' | 'fair' | 'good' };

const SAMPLE_WINDOW_MS = 12_000;
const MIN_SIGNAL_MS = 8_000;
const MIN_SAMPLES = 100;
const MIN_BPM = 48;
const MAX_BPM = 180;

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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

export default function BiometricsMonitor({ cameraEnabled, videoRef }: Props) {
  const [focus, setFocus] = useState(50);
  const [load, setLoad] = useState(35);
  const [running, setRunning] = useState(false);
  const [signals, setSignals] = useState<Sample[]>([]);
  const [pulse, setPulse] = useState<PulseEstimate | null>(null);
  const [quality, setQuality] = useState<'waiting' | 'face-area' | 'lighting' | 'collecting' | 'low-fps' | 'ready'>('waiting');
  const [signalLevel, setSignalLevel] = useState(0);
  const [faceFrame, setFaceFrame] = useState({ x: 0.28, y: 0.14, width: 0.44, height: 0.58 });
  const [notes, setNotes] = useState('Sit still, face the camera, and use steady, bright light.');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<Sample[]>([]);
  const frameRef = useRef<number | null>(null);
  const lastSampleAtRef = useRef(0);
  const lastUiAtRef = useRef(0);
  const lastMotionRef = useRef<{ x: number; y: number } | null>(null);
  const paused = !cameraEnabled || !running;

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
    let detector: FaceDetector | null = null;
    try {
      if ('FaceDetector' in window) detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
    } catch { detector = null; }
    let detectionInFlight = false;
    let frameCount = 0;
    let faceBox: { x: number; y: number; width: number; height: number } | null = null;
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
          if (disposed || !faces[0]) return;
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
      if (faceBox) setFaceFrame(faceBox);

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
      if (detector && 'close' in detector && typeof detector.close === 'function') detector.close();
    };
  }, [paused, videoRef]);

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
        {!cameraEnabled && <div className="bio-callout"><Camera size={18} /><div><strong>Camera is off</strong><span>Enable the camera using the control above. Nothing starts automatically.</span></div></div>}
        {cameraEnabled && <div className="bio-consent-note"><ShieldCheck size={15} /> Camera frames are sampled in this tab. Raw video and samples are not saved or uploaded.</div>}
        {cameraEnabled && <div className="bio-controls"><button className="button button-primary" onClick={() => setRunning((value) => !value)}>{running ? 'Pause signal sampling' : 'Start signal sampling'}</button><span>Sampling is off until you start it.</span></div>}
        <div className="biometrics-grid">
          <section className="bio-panel bio-pulse-panel">
            <div className="bio-panel-top"><span><HeartPulse size={15} /> rPPG / PULSE</span><span>RGB · SPECTRUM CANDIDATE</span></div>
            <div className="bio-face-preview">
              {cameraEnabled && <video className="bio-video-mirror" ref={(node) => { const source = videoRef.current; if (node && source && source.srcObject) node.srcObject = source.srcObject; }} muted playsInline autoPlay aria-label="Mirrored camera preview" />}
              <div className="bio-face-guide" style={{ left: (faceFrame.x * 100) + '%', top: (faceFrame.y * 100) + '%', width: (faceFrame.width * 100) + '%', height: (faceFrame.height * 100) + '%' }}><span>FACE ROI</span></div>
              {!cameraEnabled && <div className="bio-preview-placeholder"><Camera size={24} /><span>Camera preview appears after opt-in</span></div>}
            </div>
            <div className="bio-heart-metric"><div><span className="field-label">ESTIMATED PULSE</span><div className="bio-bpm">{pulse ? pulse.bpm : '—'} <small>BPM</small></div></div><div className="bio-confidence"><span className="field-label">SIGNAL QUALITY</span><strong className={pulse?.quality ?? 'low'}>{pulse ? pulse.quality.toUpperCase() : 'NOT READY'}</strong><span>{signals.length} samples</span></div></div>
            <div className="bio-signal-bars"><span>CAMERA LIGHT</span><div><i style={{ width: signalLevel + '%' }} /></div></div>
            <div className="bio-trace" aria-hidden="true">{Array.from({ length: 42 }, (_, index) => <i key={index} style={{ height: (8 + Math.abs(Math.sin(index * 0.72) * 15 + Math.cos(index * 0.19) * 8)) + 'px' }} />)}</div>
            <p className="bio-signal-note">{notes}</p>
            <p className="bio-disclaimer"><AlertTriangle size={14} /> Experimental rPPG estimate only. Lighting, motion, camera processing and skin tone can distort readings. Do not use this for medical decisions.</p>
          </section>
          <section className="bio-panel">
            <div className="bio-panel-top"><span><Waves size={15} /> COGNITIVE CHECK-IN</span><span>SELF-REPORTED</span></div>
            <p className="bio-explainer">A webcam cannot reliably tell you how focused or stressed you feel. Record your own state to compare with the camera signal during an experiment.</p>
            <div className="bio-self-report"><label htmlFor="bio-focus">How focused do you feel?</label><input id="bio-focus" type="range" min="0" max="100" value={focus} onChange={(event) => setFocus(Number(event.currentTarget.value))} /><div><span>Scattered</span><strong>{focus}/100</strong><span>Focused</span></div><label htmlFor="bio-load">How mentally loaded do you feel?</label><input id="bio-load" type="range" min="0" max="100" value={load} onChange={(event) => setLoad(Number(event.currentTarget.value))} /><div><span>Light</span><strong>{load}/100</strong><span>Heavy</span></div></div>
            <div className="bio-summary-grid"><div><span>FOCUS · YOUR INPUT</span><strong>{focus}%</strong></div><div><span>LOAD · YOUR INPUT</span><strong>{load}%</strong></div></div>
            <p className="bio-disclaimer"><ShieldCheck size={14} /> Self-report values stay in component memory and are not saved.</p>
          </section>
        </div>
        <div className="bio-limits"><strong><AlertTriangle size={15} /> What this can and cannot do</strong><p>This demo visualizes camera signal quality and a rough pulse candidate. It does not detect stress, diagnose a condition, or infer emotion, truthfulness, or cognitive ability from facial movements.</p></div>
      </div>
    </div>
  );
}
