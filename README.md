# 🧠 Cogito — AI Cognitive Companion

> *A Socratic AI tutor that sees your problem, hears you think, and speaks back — no typing needed.*

Cogito is a **real-time multimodal AI tutor** powered by the **Gemini Live API**. It listens to your voice, watches your camera or screen share, and responds with a warm spoken voice — guiding you to the answer through questions, never just handing it over.

---

## ✨ What makes it special

| Feature | How it works |
|---------|-------------|
| **Sees** | Camera or screen share → JPEG frames sent every 2s to Gemini |
| **Hears** | Microphone → PCM16 audio streamed in real-time |
| **Speaks** | Gemini audio responses played back instantly in the browser |
| **Socratic** | System prompt keeps Cogito asking questions, not giving answers |
| **Barge-in** | Hold mic → Cogito stops; release → Cogito responds |
| **LaTeX** | MathJax renders inline math from Cogito's transcripts |

---

## 🏗️ Architecture

```
Browser (index.html + app.js)
  │  WebSocket (audio/image/text chunks, base64)
  ▼
FastAPI Backend (server/main.py)   ← Cloud Run
  │  google-genai SDK  (WebSocket)
  ▼
Gemini Live API (gemini-2.0-flash-live-001)
  └─ Audio in (PCM16 @ 16kHz)
  └─ Image in (JPEG frames)
  └─ Audio out (PCM16 @ 24kHz) + text transcript
```

**Google Cloud services used:**
- **Cloud Run** — serverless container hosting
- **Gemini Live API** (via Vertex AI or AI Studio) — multimodal live model
- **Google GenAI Python SDK** — `google-genai`

---

## 🚀 Quick start (local)

### 1. Clone & install

```bash
git clone https://github.com/angelaqazoo-coder/cogito
cd cogito
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt
```

### 2. Set credentials

**Option A — AI Studio (easiest):**
```bash
export GOOGLE_API_KEY="your-key-from-aistudio.google.com"
```

**Option B — Vertex AI (for Cloud Run):**
```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
gcloud auth application-default login
```

### 3. Run

```bash
uvicorn server.main:app --port 8000 --reload
```

Open [http://localhost:8000](http://localhost:8000)

---

## ☁️ Deploy to Google Cloud Run

```bash
# Build & push
gcloud builds submit --tag gcr.io/$PROJECT_ID/cogito

# Deploy
gcloud run deploy cogito \
  --image gcr.io/$PROJECT_ID/cogito \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_CLOUD_PROJECT=$PROJECT_ID \
  --memory 512Mi \
  --min-instances 1
```

> **Note:** Cloud Run supports WebSockets natively. No special configuration needed.

---

## 📁 Project structure

```
cogito/
├── server/
│   ├── main.py          # FastAPI + WebSocket proxy → Gemini Live
│   └── requirements.txt
├── frontend/
│   ├── index.html       # UI shell
│   ├── style.css        # Dark editorial design
│   ├── app.js           # WebSocket client, audio/video capture, playback
│   └── audio-processor.js  # AudioWorklet: Float32 → PCM16
├── Dockerfile           # Cloud Run ready
└── README.md
```

---

## 🧩 Hackathon compliance

| Requirement | ✅ |
|-------------|---|
| Gemini model | `gemini-2.0-flash-live-001` |
| Google GenAI SDK | `google-genai` Python SDK |
| Multimodal input | Audio (mic) + Video (camera/screen) |
| Multimodal output | Audio (spoken) + Text transcript |
| Live / real-time | WebSocket bidirectional stream |
| Barge-in | Hold-to-talk mic releases Gemini turn |
| Distinct persona | "Cogito" — warm, Socratic, never gives answers |
| Google Cloud | Cloud Run + Vertex AI |
| Beyond text-box | Voice + camera/screen UI, no typing required |

---

## 🎓 Usage tips

- **Hold the mic button** while speaking; release when done
- **Turn on camera** to show your handwritten work
- **Share screen** to share a PDF problem set
- **Click the camera icon** (📷) to send a snapshot manually
- Type in the text box as a fallback if mic isn't available
