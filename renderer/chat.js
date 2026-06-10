// chat.js — the chat panel logic (section F).
//
// Keeps the conversation in memory (the window is hidden, not destroyed, on
// close — so history survives reopening within a session), renders bubbles,
// and round-trips messages to Kimi through the main process. The API key never
// enters this renderer.

'use strict';

// How much history to send per request (beyond the system persona, which main
// prepends). Trims old turns to keep requests bounded.
const HISTORY_LIMIT = 20;

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const micEl = document.getElementById('mic');
const closeEl = document.getElementById('close');

// Conversation history as Kimi messages: {role:'user'|'assistant', content}.
const history = [];

// One in-flight request at a time.
let sending = false;

function addBubble(cls, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'msg dog typing';
  div.innerHTML = '<i></i><i></i><i></i>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Local greeting (no API call) so the panel feels alive on first open.
addBubble('dog', '汪！我是多吉🐶 打字或者按 🎤 跟我说话都行～');

// Send a message. With no argument it sends the input box's content; voice
// input calls it with the transcript directly.
async function sendMessage(textOverride) {
  const fromBox = textOverride === undefined;
  const text = (fromBox ? inputEl.value : textOverride).trim();
  if (!text || sending) return;
  if (fromBox) {
    inputEl.value = '';
    autosize();
  }

  addBubble('user', text);
  history.push({ role: 'user', content: text });

  sending = true;
  sendEl.disabled = true;
  const typing = addTyping();

  let res;
  try {
    res = await window.chat.send(history.slice(-HISTORY_LIMIT));
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }

  typing.remove();
  sending = false;
  sendEl.disabled = false;

  if (res && res.ok) {
    // The model occasionally slips in markdown bold; bubbles are plain text,
    // so strip the markers for display (history keeps the original).
    addBubble('dog', res.content.replace(/\*\*(.+?)\*\*/g, '$1'));
    history.push({ role: 'assistant', content: res.content });
  } else {
    // Errors render as a distinct bubble and are NOT added to history, so a
    // retry after fixing (e.g. filling in the API key) resends cleanly.
    addBubble('error', (res && res.error) || '出错了，再试一次？');
  }
  inputEl.focus();
}

// Grow the textarea with content (capped by CSS max-height).
function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = inputEl.scrollHeight + 'px';
}

// ---- Voice input (section G) -------------------------------------------------
//
// Click 🎤 to record, click again to stop. The webm/opus recording is decoded,
// resampled to 16 kHz mono, WAV-encoded, then transcribed in main; the
// transcript flows through sendMessage like a typed message — 多吉 replies in
// a normal text bubble.

const REC_MAX_MS = 60 * 1000; // safety cap per recording
let rec = null; // active MediaRecorder (null = not recording)
let recChunks = [];
let recStream = null;
let recTimer = null;

async function toggleRecording() {
  if (rec) {
    rec.stop(); // → onRecordingStop
    return;
  }
  try {
    await window.chat.ensureMic(); // macOS permission prompt (first time)
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    addBubble(
      'error',
      '用不了麦克风：去 系统设置 → 隐私与安全性 → 麦克风，允许本应用后再试。'
    );
    return;
  }
  recChunks = [];
  rec = new MediaRecorder(recStream, { mimeType: 'audio/webm' });
  rec.ondataavailable = (e) => recChunks.push(e.data);
  rec.onstop = onRecordingStop;
  rec.start();
  micEl.classList.add('recording');
  micEl.textContent = '■';
  recTimer = setTimeout(() => rec && rec.stop(), REC_MAX_MS);
}

async function onRecordingStop() {
  clearTimeout(recTimer);
  micEl.classList.remove('recording');
  micEl.textContent = '🎤';
  if (recStream) recStream.getTracks().forEach((t) => t.stop());
  recStream = null;
  const blob = new Blob(recChunks, { type: 'audio/webm' });
  rec = null;
  if (blob.size < 1500) {
    addBubble('error', '没录到声音，再试一次？');
    return;
  }
  const typing = addTyping(); // "听写中" dots
  try {
    const wavB64 = await blobToWav16kB64(blob);
    const r = await window.chat.transcribe(wavB64);
    typing.remove();
    if (r && r.ok) {
      sendMessage(r.text); // transcript becomes a normal user message
    } else {
      addBubble('error', (r && r.error) || '没听清，再说一遍？');
    }
  } catch (err) {
    typing.remove();
    addBubble('error', '录音处理失败：' + ((err && err.message) || err));
  }
}

// Decode any audio blob the recorder produced, resample to 16 kHz mono, and
// return base64 16-bit PCM WAV — small, and exactly what the STT model wants.
async function blobToWav16kB64(blob) {
  const TARGET = 16000;
  const raw = await blob.arrayBuffer();
  const ac = new AudioContext();
  let decoded;
  try {
    decoded = await ac.decodeAudioData(raw);
  } finally {
    ac.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET));
  const oac = new OfflineAudioContext(1, frames, TARGET);
  const src = oac.createBufferSource();
  src.buffer = decoded;
  src.connect(oac.destination);
  src.start();
  const rendered = await oac.startRendering();
  const pcm = rendered.getChannelData(0);

  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF');
  out.setUint32(4, 36 + pcm.length * 2, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  out.setUint32(16, 16, true); // PCM chunk size
  out.setUint16(20, 1, true); // PCM format
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, TARGET, true);
  out.setUint32(28, TARGET * 2, true); // byte rate
  out.setUint16(32, 2, true); // block align
  out.setUint16(34, 16, true); // bits per sample
  ws(36, 'data');
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  const bytes = new Uint8Array(out.buffer);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

micEl.addEventListener('click', toggleRecording);

sendEl.addEventListener('click', () => sendMessage());
inputEl.addEventListener('input', autosize);
inputEl.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter inserts a newline. Respect IME composition so
  // confirming Chinese candidates with Enter doesn't fire a send.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  } else if (e.key === 'Escape') {
    window.chat.hide();
  }
});

closeEl.addEventListener('click', () => window.chat.hide());

inputEl.focus();
