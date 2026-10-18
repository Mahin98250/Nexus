"""Local-only DeepFace facial-expression API for Nexus VitalSense.

Frames are decoded and analyzed in memory. This service never writes uploaded
images to disk or persists analysis results.
"""
from __future__ import annotations

import os
from typing import Any

import cv2
import numpy as np
from deepface import DeepFace
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

MAX_UPLOAD_BYTES = 4 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}

DEFAULT_ORIGINS = (
    "http://localhost:5173,"
    "http://127.0.0.1:5173,"
    "https://mahin98250.github.io"
)
allowed_origins = [
    origin.strip()
    for origin in os.getenv("VITALSENSE_ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if origin.strip()
]

app = FastAPI(
    title="Nexus VitalSense DeepFace API",
    version="1.0.0",
    description=(
        "Opt-in, frame-by-frame facial-expression estimates. "
        "This is not a micro-expression detector or medical device."
    ),
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    """Simple liveness check; the model loads on the first analysis request."""
    return {"status": "ok", "service": "nexus-vitalsense-deepface"}


@app.post("/analyze")
def analyze_expression(image: UploadFile = File(...)) -> dict[str, Any]:
    """Analyze one user-submitted frame without storing it."""
    if image.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Upload a JPEG, PNG, or WebP image.",
        )

    raw = image.file.read(MAX_UPLOAD_BYTES + 1)
    if not raw:
        raise HTTPException(status_code=400, detail="The uploaded image is empty.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 4 MB limit.")

    encoded = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(status_code=400, detail="The uploaded image could not be decoded.")

    height, width = frame.shape[:2]
    if width < 64 or height < 64:
        raise HTTPException(status_code=400, detail="Image resolution is too small.")
    if width > 1920 or height > 1920:
        raise HTTPException(status_code=413, detail="Image dimensions exceed the allowed limit.")

    try:
        # DeepFace's emotion head estimates broad facial-expression categories.
        # It does not model brief temporal micro-expression sequences.
        analysis = DeepFace.analyze(
            img_path=frame,
            actions=["emotion"],
            detector_backend="opencv",
            enforce_detection=True,
            align=True,
            silent=True,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail="No usable face was found. Face the camera and improve lighting.",
        ) from exc
    except Exception as exc:  # model/runtime errors should not expose server internals
        raise HTTPException(
            status_code=503,
            detail="DeepFace could not analyze this frame. Check model setup and server logs.",
        ) from exc

    faces = analysis if isinstance(analysis, list) else [analysis]
    faces = [face for face in faces if isinstance(face, dict) and isinstance(face.get("emotion"), dict)]
    if not faces:
        raise HTTPException(status_code=422, detail="No facial-expression result was produced.")

    # Prefer the detected face with the highest detector confidence, when available.
    face = max(faces, key=lambda item: float(item.get("face_confidence") or 0.0))
    scores = {
        str(label): round(float(score), 3)
        for label, score in face["emotion"].items()
        if isinstance(score, (int, float)) and np.isfinite(score)
    }
    if not scores:
        raise HTTPException(status_code=503, detail="The emotion model returned no scores.")

    dominant = str(face.get("dominant_emotion") or max(scores, key=scores.get))
    confidence = face.get("face_confidence")
    try:
        face_confidence = float(confidence) if confidence is not None else None
    except (TypeError, ValueError):
        face_confidence = None

    return {
        "model": "DeepFace emotion head",
        "dominant_emotion": dominant,
        "emotion_scores": scores,
        "face_confidence": face_confidence,
        "disclaimer": (
            "Frame-level expression estimate only; not a validated micro-expression, "
            "internal-emotion, stress, or cognitive-load measurement."
        ),
    }
