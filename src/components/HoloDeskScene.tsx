import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { HandInputRef } from '../vision/types';

type HoloDeskSceneProps = {
  inputRef: HandInputRef;
  cameraEnabled: boolean;
};

export default function HoloDeskScene({ inputRef, cameraEnabled }: HoloDeskSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cameraEnabledRef = useRef(cameraEnabled);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const [fallbackOffset, setFallbackOffset] = useState({ x: 0, y: 0 });
  const [fallbackRotation, setFallbackRotation] = useState(0);
  const [motionPaused, setMotionPaused] = useState(false);
  const motionPausedRef = useRef(false);
  const fallbackDragRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  cameraEnabledRef.current = cameraEnabled;
  motionPausedRef.current = motionPaused;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
        precision: 'highp',
      });
    } catch {
      setWebglUnavailable(true);
      host.classList.add('holo-scene-unavailable');
      return;
    }
    setWebglUnavailable(false);
    let disposed = false;
    let rendererFailed = false;
    const switchToFallback = () => {
      if (disposed || rendererFailed) return;
      rendererFailed = true;
      host.classList.add('holo-scene-unavailable');
      setWebglUnavailable(true);
    };

    const onWebGLContextLost = (event: Event) => {
      event.preventDefault();
      switchToFallback();
    };
    renderer.domElement.addEventListener('webglcontextlost', onWebGLContextLost);

    // Preserve crisp, antialiased geometry while keeping the mobile render budget bounded.
    const touchDevice = window.matchMedia('(pointer: coarse)').matches;
    const lowPowerDevice = (navigator.hardwareConcurrency || 4) <= 4;
    const particleCount = lowPowerDevice ? 112 : 220;
    const curveSegments = touchDevice ? 144 : 192;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touchDevice ? 1.65 : 2));
    renderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.domElement.className = 'holo-canvas';
    renderer.domElement.setAttribute('aria-label', 'Interactive three-dimensional hologram. Drag with a mouse or hold a pinch gesture to move it.');
    host.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, Math.max(host.clientWidth, 1) / Math.max(host.clientHeight, 1), 0.1, 100);
    camera.position.set(0, 0, 8.4);

    scene.add(new THREE.AmbientLight(0xb3c4ff, 1.7));
    const keyLight = new THREE.PointLight(0x9883ff, 45, 18);
    keyLight.position.set(2, 3, 5);
    scene.add(keyLight);
    const cyanLight = new THREE.PointLight(0x57e4df, 30, 14);
    cyanLight.position.set(-3, -1, 3);
    scene.add(cyanLight);

    const root = new THREE.Group();
    scene.add(root);

    const coreMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x9b8cff,
      emissive: 0x5b3be0,
      emissiveIntensity: 0.58,
      metalness: 0.28,
      roughness: 0.24,
      transparent: true,
      opacity: 0.84,
      clearcoat: 1,
    });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.86, lowPowerDevice ? 2 : 3), coreMaterial);
    root.add(core);

    const wire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.94, 2),
      new THREE.MeshBasicMaterial({ color: 0xd8d0ff, wireframe: true, transparent: true, opacity: 0.76 }),
    );
    root.add(wire);

    const innerCore = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.37, 1),
      new THREE.MeshStandardMaterial({ color: 0x83f0e5, emissive: 0x35b9bd, emissiveIntensity: 1.25, metalness: 0.2, roughness: 0.2 }),
    );
    root.add(innerCore);

    const ringOne = new THREE.Mesh(
      new THREE.TorusGeometry(1.3, 0.012, 8, curveSegments),
      new THREE.MeshBasicMaterial({ color: 0x9c8dff, transparent: true, opacity: 0.8 }),
    );
    ringOne.rotation.x = 0.92;
    ringOne.rotation.y = 0.25;
    root.add(ringOne);

    const ringTwo = new THREE.Mesh(
      new THREE.TorusGeometry(1.55, 0.006, 6, curveSegments),
      new THREE.MeshBasicMaterial({ color: 0x5adbd7, transparent: true, opacity: 0.52 }),
    );
    ringTwo.rotation.x = 1.2;
    ringTwo.rotation.y = -0.5;
    root.add(ringTwo);

    const particlePositions = new Float32Array(particleCount * 3);
    for (let index = 0; index < particleCount; index += 1) {
      const radius = 1.8 + Math.random() * 2.3;
      const theta = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * 4.3;
      particlePositions[index * 3] = Math.cos(theta) * radius;
      particlePositions[index * 3 + 1] = y;
      particlePositions[index * 3 + 2] = (Math.random() - 0.5) * 2.4;
    }
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    const particles = new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({ color: 0xaaa1ff, size: 0.022, transparent: true, opacity: 0.76, sizeAttenuation: true, depthWrite: false }),
    );
    scene.add(particles);

    const target = new THREE.Vector3(0, 0, 0);
    const pointerTarget = new THREE.Vector3();
    let pointerDragging = false;
    let animationFrame = 0;
    let lastTime = 0;
    let displayedPinch = false;
    let smoothedAngle = 0;
    let smoothedHandX = 0.5;
    let smoothedHandY = 0.5;
    let hasSmoothedHand = false;
    let lastHandSampleAt = 0;

    const setPointerTarget = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const normalizedX = (event.clientX - rect.left) / Math.max(rect.width, 1);
      const normalizedY = (event.clientY - rect.top) / Math.max(rect.height, 1);
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
      pointerTarget.set((normalizedX - 0.5) * halfHeight * camera.aspect * 2, (0.5 - normalizedY) * halfHeight * 2, 0);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDragging = true;
      renderer.domElement.setPointerCapture(event.pointerId);
      setPointerTarget(event);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pointerDragging) setPointerTarget(event);
    };
    const onPointerUp = () => { pointerDragging = false; };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);

    const resizeObserver = new ResizeObserver(() => {
      if (disposed || rendererFailed) return;
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      try { renderer.setSize(width, height); } catch { switchToFallback(); }
    });
    resizeObserver.observe(host);

    const tick = (time: number) => {
      if (disposed || rendererFailed) return;
      animationFrame = requestAnimationFrame(tick);
      const delta = Math.min((time - (lastTime || time)) / 1000, 0.04);
      lastTime = time;

      const input = inputRef.current;
      if (cameraEnabledRef.current && input.detected && input.pinch) {
        // Adaptive low-pass: suppress fingertip jitter when steady, but reduce
        // lag automatically when the hand moves quickly (AirHand-style response).
        if (!hasSmoothedHand) {
          smoothedHandX = input.x;
          smoothedHandY = input.y;
          hasSmoothedHand = true;
        }
        const sampleAt = input.timestamp || time;
        const sampleDelta = Math.max(1, Math.min(100, sampleAt - (lastHandSampleAt || sampleAt - 16)));
        const handDelta = Math.hypot(input.x - smoothedHandX, input.y - smoothedHandY);
        const handSpeed = handDelta / sampleDelta * 1000;
        const smoothing = handSpeed > 1.7 || handDelta > 0.12 ? 0.82
          : handSpeed > 0.65 || handDelta > 0.045 ? 0.62 : 0.34;
        const sampleFactor = 1 - Math.pow(1 - smoothing, Math.max(0.25, delta * 60));
        if (handDelta > 0.0011) {
          smoothedHandX += (input.x - smoothedHandX) * sampleFactor;
          smoothedHandY += (input.y - smoothedHandY) * sampleFactor;
        }
        lastHandSampleAt = sampleAt;
        // Match the mouse/touch camera-frustum transform exactly.
        const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
        target.set(
          (smoothedHandX - 0.5) * halfHeight * camera.aspect * 2,
          (0.5 - smoothedHandY) * halfHeight * 2,
          0,
        );
        displayedPinch = true;
        const angleDiff = Math.atan2(Math.sin(input.angle - smoothedAngle), Math.cos(input.angle - smoothedAngle));
        smoothedAngle += angleDiff * (handSpeed > 0.7 ? 0.34 : 0.2);
      } else if (displayedPinch && (!input.detected || !input.pinch)) {
        displayedPinch = false;
        hasSmoothedHand = false;
        lastHandSampleAt = 0;
      }

      if (pointerDragging) {
        target.copy(pointerTarget);
        displayedPinch = true;
      } else if (!input.detected || !input.pinch) {
        displayedPinch = false;
      }

      root.position.lerp(target, 1 - Math.exp(-delta * (displayedPinch ? 24 : 3.2)));
      const timeSeconds = time * 0.001;
      if (!motionPausedRef.current) {
        root.rotation.y += delta * (displayedPinch ? 0.45 : 0.3);
        root.rotation.x = Math.sin(timeSeconds * 0.65) * 0.12 + smoothedAngle * (displayedPinch ? 0.22 : 0.05);
        core.rotation.y = -timeSeconds * 0.12;
        innerCore.rotation.x = timeSeconds * 0.55;
        innerCore.rotation.y = -timeSeconds * 0.75;
        wire.rotation.copy(core.rotation);
        ringOne.rotation.z = timeSeconds * 0.17;
        ringTwo.rotation.z = -timeSeconds * 0.11;
        particles.rotation.y = timeSeconds * 0.018;
        particles.rotation.x = Math.sin(timeSeconds * 0.13) * 0.025;
      }

      const pulse = motionPausedRef.current ? 1 : 1 + Math.sin(timeSeconds * 2.3) * 0.016;
      root.scale.setScalar(pulse * (displayedPinch ? 1.06 : 1));
      try {
        renderer.render(scene, camera);
      } catch {
        switchToFallback();
      }
    };
    animationFrame = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', onWebGLContextLost);
      try { renderer.dispose(); } catch { /* Context may already be lost. */ }
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.domElement.remove();
    };
  }, [inputRef]);

  // Keep pinch-to-move available in the 2D fallback as well as normal WebGL mode.
  useEffect(() => {
    if (!webglUnavailable) return;
    let frame = 0;
    let lastUpdate = 0;
    const updateFromHand = (now: number) => {
      frame = requestAnimationFrame(updateFromHand);
      if (now - lastUpdate < 33) return;
      lastUpdate = now;
      const input = inputRef.current;
      const host = hostRef.current;
      if (!host || !cameraEnabledRef.current || !input.detected || !input.pinch) return;
      setFallbackOffset({
        x: (input.x - 0.5) * Math.max(host.clientWidth, 1) * 0.7,
        y: (input.y - 0.5) * Math.max(host.clientHeight, 1) * 0.7,
      });
      setFallbackRotation(THREE.MathUtils.radToDeg(input.angle));
    };
    frame = requestAnimationFrame(updateFromHand);
    return () => cancelAnimationFrame(frame);
  }, [webglUnavailable, inputRef]);

  return (
    <div ref={hostRef} className="holo-scene-layer">
      {webglUnavailable && (
        <div
          className="holo-fallback-scene"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            fallbackDragRef.current = { x: event.clientX, y: event.clientY, originX: fallbackOffset.x, originY: fallbackOffset.y };
          }}
          onPointerMove={(event) => {
            const drag = fallbackDragRef.current;
            if (!drag) return;
            setFallbackOffset({ x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y });
          }}
          onPointerUp={() => { fallbackDragRef.current = null; }}
          onPointerCancel={() => { fallbackDragRef.current = null; }}
          aria-label="Interactive lightweight hologram fallback. Drag to move."
        >
          <div className="holo-fallback-orbit holo-fallback-orbit-one" />
          <div className="holo-fallback-orbit holo-fallback-orbit-two" />
          <div className="holo-fallback-core" style={{ transform: `translate(${fallbackOffset.x}px, ${fallbackOffset.y}px) rotate(${fallbackRotation + fallbackOffset.x * 0.3}deg)` }}>
            <div className="holo-fallback-inner" />
          </div>
          <p>LIGHTWEIGHT HOLOGRAM · DRAG TO MOVE</p>
        </div>
      )}
      <div className="holo-scene-hud"><span className={cameraEnabled ? 'status-dot active' : 'status-dot'} /> {cameraEnabled ? 'PINCH TO GRAB' : 'DRAG TO INTERACT'}</div>
      <div className="holo-scene-footnote">NEXUS SPATIAL ENGINE <span>·</span> {webglUnavailable ? 'FALLBACK SCENE' : 'LIVE SCENE'}</div>
    </div>
  );
}
