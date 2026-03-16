"""
Cogito — AI Cognitive Companion
Backend: FastAPI + Gemini Live API (Google GenAI SDK)
Hosted on: Google Cloud Run
"""

import asyncio
import base64
import json
import logging
import os
import uuid
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import google.genai as genai
from google.genai import types

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
GOOGLE_CLOUD_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
MODEL = "gemini-2.0-flash-live-001"

SYSTEM_INSTRUCTION = """
You are Cogito — a warm, Socratic math and science tutor with a calm, encouraging voice.
Your personality:
- Never give answers directly. Instead, guide with questions: "What do you think comes next?"
- Celebrate breakthroughs: "Exactly! You got it."
- When you see a photo of a problem, describe what you observe, then ask the student to explain their approach.
- Speak naturally, as if face-to-face. Use short sentences. Pause often.
- If the student is stuck, offer the smallest possible hint — not the solution.
- Always end your turn with a question to keep the dialogue going.
You can see images (camera/screen) and hear the student's voice in real time.
"""

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Cogito", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve frontend
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_dir):
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")


@app.get("/")
async def root():
    index = os.path.join(frontend_dir, "index.html")
    if os.path.isfile(index):
        return FileResponse(index)
    return {"status": "Cogito backend running", "version": "2.0.0"}


@app.get("/health")
async def health():
    return {"status": "healthy", "model": MODEL}


# ── Gemini Session Manager ─────────────────────────────────────────────────────
class GeminiSession:
    """Wraps a single Gemini Live API session for one student."""

    def __init__(self, client_ws: WebSocket):
        self.client_ws = client_ws
        self.session_id = str(uuid.uuid4())[:8]
        self._send_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._active = True

    async def run(self):
        """Bridge: client WebSocket ↔ Gemini Live session."""
        client = genai.Client(
            api_key=GOOGLE_API_KEY if GOOGLE_API_KEY else None,
            vertexai=bool(GOOGLE_CLOUD_PROJECT),
            project=GOOGLE_CLOUD_PROJECT or None,
            location="us-central1" if GOOGLE_CLOUD_PROJECT else None,
        )

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=types.Content(
                parts=[types.Part(text=SYSTEM_INSTRUCTION)]
            ),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
                )
            ),
        )

        try:
            async with client.aio.live.connect(model=MODEL, config=config) as session:
                logger.info(f"[{self.session_id}] Gemini session opened")
                await asyncio.gather(
                    self._recv_from_client(session),
                    self._recv_from_gemini(session),
                )
        except Exception as e:
            logger.error(f"[{self.session_id}] Session error: {e}")
        finally:
            self._active = False
            logger.info(f"[{self.session_id}] Session closed")

    async def _recv_from_client(self, session):
        """Forward client messages → Gemini."""
        try:
            while self._active:
                raw = await self.client_ws.receive_text()
                msg = json.loads(raw)
                kind = msg.get("type")

                if kind == "audio":
                    # PCM16 audio chunk from browser microphone
                    audio_bytes = base64.b64decode(msg["data"])
                    await session.send(
                        input=types.LiveClientRealtimeInput(
                            media_chunks=[
                                types.Blob(
                                    data=audio_bytes,
                                    mime_type="audio/pcm;rate=16000",
                                )
                            ]
                        )
                    )

                elif kind == "image":
                    # JPEG frame from webcam / screen share
                    img_bytes = base64.b64decode(msg["data"])
                    await session.send(
                        input=types.LiveClientRealtimeInput(
                            media_chunks=[
                                types.Blob(
                                    data=img_bytes,
                                    mime_type="image/jpeg",
                                )
                            ]
                        )
                    )

                elif kind == "text":
                    # Typed message fallback
                    await session.send(input=msg.get("data", ""), end_of_turn=True)

        except WebSocketDisconnect:
            self._active = False
        except Exception as e:
            logger.warning(f"[{self.session_id}] Client recv error: {e}")
            self._active = False

    async def _recv_from_gemini(self, session):
        """Forward Gemini responses → client."""
        try:
            async for response in session.receive():
                if not self._active:
                    break

                # Audio response → stream back as base64
                if response.data:
                    payload = {
                        "type": "audio",
                        "data": base64.b64encode(response.data).decode(),
                    }
                    await self._safe_send(json.dumps(payload))

                # Text / transcript chunks
                for part in (response.server_content.model_turn.parts
                             if response.server_content and response.server_content.model_turn
                             else []):
                    if part.text:
                        await self._safe_send(
                            json.dumps({"type": "transcript", "text": part.text})
                        )

                # Turn-complete signal
                if response.server_content and response.server_content.turn_complete:
                    await self._safe_send(json.dumps({"type": "turn_complete"}))

        except Exception as e:
            logger.warning(f"[{self.session_id}] Gemini recv error: {e}")
            self._active = False

    async def _safe_send(self, data: str):
        try:
            await self.client_ws.send_text(data)
        except Exception:
            self._active = False


# ── WebSocket Endpoint ─────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    gemini_session = GeminiSession(websocket)
    try:
        await gemini_session.run()
    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
