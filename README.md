# Nexus

**The world beyond touch.** Nexus is a browser-based gesture playground that puts four experimental experiences under one roof.

## The four experiences

### 01 · HoloDesk
A Three.js hologram with animated geometry, orbit rings, and particles. Drag the object with a mouse or touchscreen; with the camera enabled, make a thumb-index pinch and move your hand to reposition it.

### 02 · ShadowStrike
A camera-optional arcade game. Move left and right with the keyboard or touch buttons, punch falling targets, build your score, and manage three energy points. With the camera enabled, a pose model maps body position to steering and a raised wrist to a strike. The pose-derived jump signal adds a dodge animation.

### 03 · AirOS
A simulated desktop inside the browser. Open, close, minimize, and move application windows; write notes saved in local storage; use a deliberately restricted demo terminal; switch the desktop theme; and generate an ambient tone locally with the Web Audio API. It does not execute operating-system commands or provide system-wide control.

### 04 · RealityScan Live
A live object-detection view using MediaPipe's EfficientDet Lite model. It draws confidence-labelled boxes with short-lived IDs and smoothing to reduce visual jitter. IDs are lightweight visual associations, not guaranteed persistent identities or a full multi-object tracker.

## VitalSense DeepFace expression classifier

VitalSense includes an optional DeepFace API integration for frame-by-frame facial-expression estimates. The browser UI is opt-in and sends a reduced-resolution frame only while expression analysis is enabled. The service processes frames in memory and does not save them.

**This is not a micro-expression classifier.** DeepFace's emotion head predicts broad expression categories from individual frames; it cannot reliably reveal internal emotion, stress, or cognitive load. Read the setup and privacy notes in [services/deepface/README.md](services/deepface/README.md) before enabling it. The service is not deployed by GitHub Pages; run it locally or configure a secured API you control.

## Development

Requirements: Node.js 22.12 or newer and npm.

```bash
npm install
npm run dev
```

Checks:

```bash
npm run typecheck
npm run test
npm run build
npm audit --audit-level=high
```

## Privacy and limitations

- Camera access is requested only after you choose **Enable camera**.
- The video frames and MediaPipe inference are processed in the browser by the app. This code does not upload camera frames to a Nexus server.
- Vision WASM files and model assets are downloaded from public CDNs/object storage on first use, so camera experiences need an internet connection to initialize unless those assets are already cached.
- Browser camera access generally requires HTTPS or localhost and explicit permission.
- Inference speed and accuracy depend on lighting, camera framing, browser, and device performance. Hand and pose heuristics are prototypes and may miss or misclassify gestures.
- AirOS is a browser-based interface, not a replacement for the device operating system. Its terminal is simulated and never invokes a shell.
- Run hands-on camera, touch, and mobile-browser validation before treating this as a stable public release.

## Stack

React · TypeScript · Vite · MediaPipe Tasks Vision · Three.js · Lucide · Vitest

## Project status

This is an actively developed prototype. CI currently runs a dependency audit, TypeScript checks, gesture unit tests, and the production build. A green CI run verifies those automated checks; it does not replace physical-device camera and interaction testing.

## Deploying a live demo with GitHub Pages

This app uses Vite, so publishing the source tree directly with the default Jekyll branch publisher is not enough for the interactive app. To publish the built app:

1. Open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
2. Open **Actions → Deploy Nexus to GitHub Pages → Run workflow**.
3. When the workflow finishes successfully, open the Pages URL shown in the deployment job.

The manual deployment workflow builds with the project path `/Nexus/`, audits dependencies, and publishes only the generated `dist` artifact.
