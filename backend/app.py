from __future__ import annotations

import base64
import os
import time
import uuid
from collections import deque
from dataclasses import dataclass, asdict
from typing import Any, cast

import cv2
import dlib
import imutils
import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from imutils import face_utils
from scipy.spatial import distance


app = FastAPI(title="Driver Drowsiness API", version="2.0.0")

# Comma-separated origins via env, e.g.:
# CORS_ORIGINS=https://your-frontend.vercel.app,https://www.yourdomain.com
cors_origins_env = os.getenv("CORS_ORIGINS", "")
if cors_origins_env.strip():
    cors_origins = [origin.strip() for origin in cors_origins_env.split(",") if origin.strip()]
else:
    cors_origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@dataclass
class DriverStats:
    blink_count: int = 0
    yawn_count: int = 0
    drowsiness_events: int = 0
    session_start: float = 0.0


@dataclass
class DriverStatus:
    eye_status: str = "OPEN"
    yawning: str = "NO"
    driver_status: str = "ACTIVE"
    alert_level: str = "LOW"
    confidence: float = 0.0
    ear: float = 0.0
    mar: float = 0.0
    face_detected: bool = False


@dataclass
class SessionState:
    stats: DriverStats
    status: DriverStatus
    closed_eye_counter: int = 0
    yawn_counter: int = 0
    blink_in_progress: bool = False
    yawn_in_progress: bool = False
    prev_driver_status: str = "ACTIVE"
    yawn_event_times: deque[float] | None = None
    yawn_alarm_armed: bool = True
    eye_alarm_armed: bool = True
    sound_event_id: int = 0
    last_seen: float = 0.0


class StartSessionRequest(BaseModel):
    session_id: str | None = None


class InferRequest(BaseModel):
    session_id: str
    image_base64: str


SESSIONS: dict[str, SessionState] = {}
SESSION_TTL_SECONDS = 1800

EAR_THRESHOLD = 0.25
SLEEPING_FRAMES = 28
DROWSY_FRAMES = 16
MOUTH_THRESHOLD = 0.62
MOUTH_FRAMES = 4

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_CANDIDATES = [
    os.path.join(BASE_DIR, "models", "shape_predictor_68_face_landmarks.dat"),
    os.path.join(BASE_DIR, "..", "models", "shape_predictor_68_face_landmarks.dat"),
]
MODEL_PATH = next((p for p in MODEL_CANDIDATES if os.path.exists(p)), MODEL_CANDIDATES[0])
if not os.path.exists(MODEL_PATH):
    raise FileNotFoundError(
        f"Missing model file. Checked: {', '.join(MODEL_CANDIDATES)}"
    )
# dlib exposes some symbols dynamically, which can confuse static analyzers (Pylance).
DETECTOR = cast(Any, getattr(dlib, "get_frontal_face_detector"))()
PREDICTOR = cast(Any, getattr(dlib, "shape_predictor"))(MODEL_PATH)

(L_START, L_END) = face_utils.FACIAL_LANDMARKS_68_IDXS["left_eye"]
(R_START, R_END) = face_utils.FACIAL_LANDMARKS_68_IDXS["right_eye"]
(M_START, M_END) = face_utils.FACIAL_LANDMARKS_68_IDXS["mouth"]


def eye_aspect_ratio(eye: np.ndarray) -> float:
    a = distance.euclidean(eye[1], eye[5])
    b = distance.euclidean(eye[2], eye[4])
    c = distance.euclidean(eye[0], eye[3])
    return (a + b) / (2.0 * c)


def mouth_aspect_ratio(mouth: np.ndarray) -> float:
    a = distance.euclidean(mouth[2], mouth[10])
    b = distance.euclidean(mouth[4], mouth[8])
    c = distance.euclidean(mouth[0], mouth[6])
    return (a + b) / (2.0 * c)


def infer_alert_level(driver_status: str) -> str:
    if driver_status == "SLEEPING":
        return "HIGH"
    if driver_status == "DROWSY":
        return "MEDIUM"
    return "LOW"


def infer_confidence(ear: float, mar: float, face_detected: bool) -> float:
    if not face_detected:
        return 0.0
    ear_component = min(1.0, abs(ear - EAR_THRESHOLD) / EAR_THRESHOLD)
    mar_component = min(1.0, max(0.0, (mar - MOUTH_THRESHOLD) / MOUTH_THRESHOLD))
    confidence = (0.65 * ear_component + 0.35 * mar_component) * 100
    return round(confidence, 2)


def decode_image(image_base64: str) -> np.ndarray | None:
    try:
        payload = image_base64.split(",", 1)[-1]
        raw = base64.b64decode(payload, validate=True)
        arr = np.frombuffer(raw, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return frame
    except Exception:
        return None


def get_or_create_session(session_id: str) -> SessionState:
    cleanup_sessions()
    if session_id not in SESSIONS:
        SESSIONS[session_id] = SessionState(
            stats=DriverStats(session_start=time.time()),
            status=DriverStatus(),
            yawn_event_times=deque(),
            last_seen=time.time(),
        )
    SESSIONS[session_id].last_seen = time.time()
    return SESSIONS[session_id]


def cleanup_sessions() -> None:
    now = time.time()
    stale_ids = [sid for sid, state in SESSIONS.items() if now - state.last_seen > SESSION_TTL_SECONDS]
    for sid in stale_ids:
        del SESSIONS[sid]


def run_inference(session: SessionState, frame: np.ndarray) -> tuple[DriverStatus, DriverStats]:
    frame = imutils.resize(frame, width=640)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    subjects = DETECTOR(gray, 0)

    status = DriverStatus()

    if len(subjects) == 0:
        session.closed_eye_counter = 0
        session.yawn_counter = 0
        session.yawn_in_progress = False
        status.face_detected = False
        session.status = status
        return status, session.stats

    shape = PREDICTOR(gray, subjects[0])
    points = face_utils.shape_to_np(shape)

    left_eye = points[L_START:L_END]
    right_eye = points[R_START:R_END]
    mouth = points[M_START:M_END]

    ear = (eye_aspect_ratio(left_eye) + eye_aspect_ratio(right_eye)) / 2.0
    mar = mouth_aspect_ratio(mouth)

    status.face_detected = True
    status.ear = round(ear, 3)
    status.mar = round(mar, 3)

    if ear < EAR_THRESHOLD:
        session.closed_eye_counter += 1
        status.eye_status = "CLOSED"
        if not session.blink_in_progress:
            session.blink_in_progress = True
    else:
        if session.blink_in_progress:
            session.stats.blink_count += 1
            session.blink_in_progress = False
        session.closed_eye_counter = 0
        status.eye_status = "OPEN"

    if mar > MOUTH_THRESHOLD:
        session.yawn_counter += 1
        status.yawning = "YES"
        if not session.yawn_in_progress and session.yawn_counter >= MOUTH_FRAMES:
            session.stats.yawn_count += 1
            session.yawn_in_progress = True
            if session.yawn_event_times is not None:
                session.yawn_event_times.append(time.time())
    else:
        session.yawn_counter = 0
        session.yawn_in_progress = False
        status.yawning = "NO"

    if session.closed_eye_counter >= SLEEPING_FRAMES:
        status.driver_status = "SLEEPING"
    elif session.closed_eye_counter >= DROWSY_FRAMES or status.yawning == "YES":
        status.driver_status = "DROWSY"
    else:
        status.driver_status = "ACTIVE"

    if status.driver_status in {"DROWSY", "SLEEPING"} and session.prev_driver_status == "ACTIVE":
        session.stats.drowsiness_events += 1
    session.prev_driver_status = status.driver_status

    status.alert_level = infer_alert_level(status.driver_status)
    status.confidence = infer_confidence(ear, mar, True)

    session.status = status
    return status, session.stats


def yawns_in_last_window(session: SessionState, seconds: int = 600) -> int:
    if session.yawn_event_times is None:
        return 0
    cutoff = time.time() - seconds
    while session.yawn_event_times and session.yawn_event_times[0] < cutoff:
        session.yawn_event_times.popleft()
    return len(session.yawn_event_times)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/session/start")
def start_session(payload: StartSessionRequest) -> JSONResponse:
    session_id = payload.session_id or str(uuid.uuid4())
    get_or_create_session(session_id)
    return JSONResponse({"session_id": session_id})


@app.post("/api/infer")
def infer(payload: InferRequest) -> JSONResponse:
    session = get_or_create_session(payload.session_id)
    frame = decode_image(payload.image_base64)
    if frame is None:
        return JSONResponse({"error": "Invalid image"}, status_code=400)

    status, stats = run_inference(session, frame)
    stats_json = asdict(stats)
    stats_json["session_seconds"] = int(time.time() - stats.session_start)

    recent_yawns = yawns_in_last_window(session, 600)
    play_sound = False
    # Trigger sound only when yawns are more than 3 (i.e., 4+) in the last 10 minutes.
    # Fire once per threshold-cross event, then re-arm only after window drops below 4.
    if recent_yawns >= 4 and session.yawn_alarm_armed:
        play_sound = True
        session.sound_event_id += 1
        session.yawn_alarm_armed = False
    elif recent_yawns < 4:
        session.yawn_alarm_armed = True

    # Trigger sound for eye-closure danger transitions as well.
    eye_danger = status.driver_status == "SLEEPING" or (
        status.driver_status == "DROWSY" and status.eye_status == "CLOSED"
    )
    if eye_danger and session.eye_alarm_armed:
        play_sound = True
        session.sound_event_id += 1
        session.eye_alarm_armed = False
    elif not eye_danger:
        session.eye_alarm_armed = True

    alert = {
        "show": status.driver_status in {"DROWSY", "SLEEPING"},
        "message": (
            "Drowsiness detected. Please take a break."
            if status.driver_status == "DROWSY"
            else "Critical: Driver appears sleeping!"
            if status.driver_status == "SLEEPING"
            else "No alert"
        ),
        "severity": status.alert_level,
        "play_sound": play_sound,
        "sound_event_id": session.sound_event_id,
        "recent_yawns_10m": recent_yawns,
    }

    return JSONResponse({"status": asdict(status), "stats": stats_json, "alert": alert})


@app.get("/api/session/{session_id}")
def session_state(session_id: str) -> JSONResponse:
    session = get_or_create_session(session_id)
    stats_json = asdict(session.stats)
    stats_json["session_seconds"] = int(time.time() - session.stats.session_start)
    return JSONResponse({"status": asdict(session.status), "stats": stats_json})
