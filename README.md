# Nexus

**The world beyond touch.** Nexus is a browser-based gesture playground bringing four real-time experiences into one app:

- **HoloDesk** — manipulate interactive 3D objects with hand gestures.
- **ShadowStrike** — play motion-controlled games using body movement.
- **AirOS** — operate a gesture-driven desktop-like interface.
- **RealityScan Live** — explore camera-based object detection and tracking.

## Stack
React, TypeScript, Vite, MediaPipe Tasks Vision, Three.js, and CSS.

## Development
```bash
npm install
npm run dev
```

Run checks:
```bash
npm run typecheck
npm run build
```

Camera features require HTTPS (or localhost) and explicit browser permission. Nexus processes camera frames in the browser; camera access is started only when you enter an experience and choose to enable it. Detection quality depends on lighting, device performance, and the selected model.

## Current milestone
The initial shell includes the four experience launchers, responsive navigation, an experience workspace, camera permission handling, and the shared vision-engine foundation. Individual experiences are being built incrementally; interface previews should not be mistaken for fully implemented OS-wide control or production-grade object recognition.
