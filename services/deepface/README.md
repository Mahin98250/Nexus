# VitalSense DeepFace expression service

This optional Python service powers the **opt-in** expression-classifier panel in VitalSense Lab.

## Important model distinction

DeepFace's emotion head classifies broad facial-expression categories from individual frames. It is **not a micro-expression classifier**: genuine micro-expression analysis requires temporal sequence models and suitable validated training data. A displayed label is a model output, not proof of someone's internal emotional state. Do not use it for medical, hiring, disciplinary, educational, or other consequential decisions.

## Run locally

Requirements: Python 3.10–3.12 recommended, pip, and internet access for the first model-weight download.

From the repository root:

```bash
python -m venv .venv
# macOS/Linux
source .venv/bin/activate
# Windows PowerShell
# .venv\Scripts\Activate.ps1
pip install -r services/deepface/requirements.txt
uvicorn app:app --app-dir services/deepface --host 127.0.0.1 --port 8000
```

Check the service at http://127.0.0.1:8000/health. The first analysis can take longer while DeepFace initializes and downloads model weights.

In VitalSense Lab:
1. Enable the camera and open the research view.
2. Leave the API endpoint at `http://127.0.0.1:8000` for local development, or enter an API endpoint you control.
3. Select **I consent · Start expression analysis** to start sending reduced-resolution JPEG frames roughly every 2.5 seconds.
4. Select **Stop classifier** to stop sending frames.

The frontend sends images only after this explicit opt-in. The API decodes and processes each image in memory and does not save uploaded frames or results. Model weights may be cached by DeepFace on the server.

## CORS for the deployed site

The default allowlist includes local Vite origins and `https://mahin98250.github.io`. Override it with a comma-separated list of exact trusted origins:

```bash
VITALSENSE_ALLOWED_ORIGINS=http://localhost:5173,https://mahin98250.github.io
```

Do not use a wildcard origin for a public deployment. For a remotely hosted API, use HTTPS, authentication, rate limits, and a deployment policy that prohibits request/image logging. Do not expose an unauthenticated GPU inference service to the public internet. Some browsers restrict requests from a hosted page to a local-network service; if that happens, run the Vite app locally or configure a secured HTTPS API you control.

## API

- `GET /health` returns service liveness.
- `POST /analyze` accepts multipart form data with an `image` field (JPEG, PNG, or WebP, max 4 MB) and returns `dominant_emotion`, `emotion_scores`, `face_confidence`, and `model`.
- No-face frames return HTTP 422; unsupported formats return 415.

This service provides per-frame expression estimates only. It does not estimate stress, cognitive load, truthfulness, or medical status.
