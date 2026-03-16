/**
 * Cogito — Frontend Application
 * Handles: WebSocket ↔ backend, mic capture, camera/screen, audio playback, UI
 */

// ── WebSocket URL ─────────────────────────────────────────────────────────────
const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
})();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusPill   = document.getElementById('status-pill');
const statusText   = document.getElementById('status-text');
const transcript   = document.getElementById('transcript');
const thinking     = document.getElementById('thinking-indicator');
const btnMic       = document.getElementById('btn-mic');
const btnCamera    = document.getElementById('btn-camera');
const btnScreen    = document.getElementById('btn-screen');
const btnSnap      = document.getElementById('btn-snap');
const cameraFeed   = document.getElementById('camera-feed');
const captureCanvas= document.getElementById('capture-canvas');
const visualOverlay= document.getElementById('visual-overlay');
const visualLabel  = document.getElementById('visual-label');
const waveformCanvas = document.getElementById('waveform');
const textInput    = document.getElementById('text-input');
const btnSend      = document.getElementById('btn-send');
const grainCanvas  = document.getElementById('grain');

// ── State ─────────────────────────────────────────────────────────────────────
let ws = null;
let isRecording = false;
let audioCtx = null;
let micStream = null;
let workletNode = null;
let analyser = null;
let videoStream = null;   // camera or screen
let videoIntervalId = null;
let playbackCtx = null;
let cogitoBuffer = [];    // accumulate PCM16 chunks for playback
let cogitoTurnActive = false;

// ── Grain animation ───────────────────────────────────────────────────────────
(function animateGrain() {
  const ctx = grainCanvas.getContext('2d');
  function resize() {
    grainCanvas.width  = window.innerWidth;
    grainCanvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);
  function draw() {
    const { width: w, height: h } = grainCanvas;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = img.data[i+1] = img.data[i+2] = v;
      img.data[i+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    requestAnimationFrame(draw);
  }
  draw();
})();

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  setStatus('connecting…');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus('live', true);
    addMessage('cogito', 'Hello! I\'m Cogito — your thinking companion. Show me a problem with your camera, or just start talking. What are we working on today?');
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'audio') {
      // Decode base64 PCM16 and queue for playback
      const raw = atob(msg.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      cogitoBuffer.push(bytes);
      cogitoTurnActive = true;
      thinking.classList.remove('visible');
    }

    if (msg.type === 'transcript') {
      appendCogitoTranscript(msg.text);
    }

    if (msg.type === 'turn_complete') {
      cogitoTurnActive = false;
      await flushAudioBuffer();
    }
  };

  ws.onclose = () => {
    setStatus('disconnected');
    setTimeout(connect, 3000);
  };

  ws.onerror = (e) => console.error('WS error', e);
}

function sendJSON(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── Status pill ───────────────────────────────────────────────────────────────
function setStatus(text, live = false) {
  statusText.textContent = text;
  statusPill.classList.toggle('live', live);
}

// ── Transcript ────────────────────────────────────────────────────────────────
let currentCogitoEl = null;

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `
    <span class="msg-role">${role === 'cogito' ? '◈ Cogito' : '◆ You'}</span>
    <div class="msg-text">${renderMath(text)}</div>
  `;
  transcript.appendChild(div);
  transcript.scrollTop = transcript.scrollHeight;
  if (role === 'cogito') currentCogitoEl = div.querySelector('.msg-text');
  typeset();
}

function appendCogitoTranscript(text) {
  if (!currentCogitoEl) {
    addMessage('cogito', '');
  }
  currentCogitoEl.innerHTML += renderMath(text);
  transcript.scrollTop = transcript.scrollHeight;
  typeset();
}

function renderMath(text) {
  // Escape HTML then leave LaTeX delimiters intact for MathJax
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\\\(/g, '\\(').replace(/\\\)/g, '\\)')
    .replace(/\\\[/g, '\\[').replace(/\\\]/g, '\\]');
}

function typeset() {
  if (window.MathJax && window.MathJax.typesetPromise) {
    window.MathJax.typesetPromise([transcript]).catch(() => {});
  }
}

// ── Microphone ────────────────────────────────────────────────────────────────
async function startMic() {
  if (isRecording) return;
  isRecording = true;
  btnMic.classList.add('recording');
  currentCogitoEl = null; // new student turn

  try {
    audioCtx = new AudioContext({ sampleRate: 16000 });
    await audioCtx.audioWorklet.addModule('/static/audio-processor.js');

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const source = audioCtx.createMediaStreamSource(micStream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    workletNode = new AudioWorkletNode(audioCtx, 'pcm16-processor');
    source.connect(workletNode);

    workletNode.port.onmessage = (e) => {
      const pcm16 = e.data.pcm16;
      sendJSON({ type: 'audio', data: arrayToBase64(new Uint8Array(pcm16.buffer)) });
    };

    drawWaveform();

  } catch (err) {
    console.error('Mic error:', err);
    stopMic();
  }
}

function stopMic() {
  isRecording = false;
  btnMic.classList.remove('recording');

  workletNode?.disconnect();
  workletNode = null;
  micStream?.getTracks().forEach(t => t.stop());
  micStream = null;
  audioCtx?.close();
  audioCtx = null;
  analyser = null;

  clearWaveform();
  thinking.classList.add('visible');
}

// ── Waveform ──────────────────────────────────────────────────────────────────
let waveRafId = null;

function drawWaveform() {
  if (!analyser) return;
  const ctx = waveformCanvas.getContext('2d');
  waveformCanvas.width  = waveformCanvas.offsetWidth;
  waveformCanvas.height = waveformCanvas.offsetHeight;

  const buf = new Uint8Array(analyser.frequencyBinCount);

  function frame() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);

    const { width: w, height: h } = waveformCanvas;
    ctx.clearRect(0, 0, w, h);

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(200,80,42,0.8)';
    ctx.lineWidth = 1.5;

    const step = w / buf.length;
    buf.forEach((v, i) => {
      const x = i * step;
      const y = (v / 128 - 1) * (h / 2) + h / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    waveRafId = requestAnimationFrame(frame);
  }
  frame();
}

function clearWaveform() {
  cancelAnimationFrame(waveRafId);
  const ctx = waveformCanvas.getContext('2d');
  ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
}

// ── Audio playback (Cogito voice) ─────────────────────────────────────────────
async function flushAudioBuffer() {
  if (!cogitoBuffer.length) return;
  const chunks = cogitoBuffer.splice(0);

  // Concatenate all PCM16 chunks
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }

  // Convert PCM16 @ 24kHz → Float32
  const samples = new Int16Array(merged.buffer);
  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;

  playbackCtx = playbackCtx || new AudioContext({ sampleRate: 24000 });
  const audioBuf = playbackCtx.createBuffer(1, floats.length, 24000);
  audioBuf.getChannelData(0).set(floats);

  const src = playbackCtx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(playbackCtx.destination);
  src.start();
}

// ── Camera / Screen share ─────────────────────────────────────────────────────
async function toggleCamera() {
  if (videoStream) {
    stopVideo();
    btnCamera.classList.remove('active');
  } else {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      startVideoStream();
      btnCamera.classList.add('active');
    } catch (e) {
      console.error('Camera error:', e);
    }
  }
}

async function toggleScreen() {
  if (videoStream) {
    stopVideo();
    btnScreen.classList.remove('active');
  } else {
    try {
      videoStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      startVideoStream();
      btnScreen.classList.add('active');
      videoStream.getVideoTracks()[0].onended = () => {
        stopVideo();
        btnScreen.classList.remove('active');
      };
    } catch (e) {
      console.error('Screen share error:', e);
    }
  }
}

function startVideoStream() {
  cameraFeed.srcObject = videoStream;
  visualOverlay.classList.add('hidden');
  // Send a frame every 2 seconds
  videoIntervalId = setInterval(sendVideoFrame, 2000);
}

function stopVideo() {
  videoStream?.getTracks().forEach(t => t.stop());
  videoStream = null;
  cameraFeed.srcObject = null;
  visualOverlay.classList.remove('hidden');
  clearInterval(videoIntervalId);
  videoIntervalId = null;
  btnCamera.classList.remove('active');
  btnScreen.classList.remove('active');
}

function sendVideoFrame() {
  if (!videoStream) return;
  const w = 640, h = 480;
  captureCanvas.width  = w;
  captureCanvas.height = h;
  const ctx = captureCanvas.getContext('2d');
  ctx.drawImage(cameraFeed, 0, 0, w, h);
  const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.7);
  const b64 = dataUrl.split(',')[1];
  sendJSON({ type: 'image', data: b64 });
}

function sendSnap() {
  sendVideoFrame();
  // Flash visual feedback
  cameraFeed.style.filter = 'brightness(2)';
  setTimeout(() => { cameraFeed.style.filter = ''; }, 120);
}

// ── Text input ────────────────────────────────────────────────────────────────
function sendText() {
  const text = textInput.value.trim();
  if (!text || !ws) return;
  addMessage('student', text);
  sendJSON({ type: 'text', data: text });
  textInput.value = '';
  currentCogitoEl = null;
  thinking.classList.add('visible');
}

// ── Event listeners ───────────────────────────────────────────────────────────
btnMic.addEventListener('pointerdown', (e) => { e.preventDefault(); startMic(); });
btnMic.addEventListener('pointerup',   (e) => { e.preventDefault(); stopMic(); });
btnMic.addEventListener('pointerleave',(e) => { if (isRecording) stopMic(); });

btnCamera.addEventListener('click', toggleCamera);
btnScreen.addEventListener('click', toggleScreen);
btnSnap.addEventListener('click', sendSnap);

btnSend.addEventListener('click', sendText);
textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });

// ── Utility ───────────────────────────────────────────────────────────────────
function arrayToBase64(uint8) {
  let bin = '';
  for (let i = 0; i < uint8.length; i++) bin += String.fromCharCode(uint8[i]);
  return btoa(bin);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
connect();
