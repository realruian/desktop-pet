// listener.js — hidden mic-capture renderer for the wake word (section H).
//
// Captures the microphone, resamples to 16 kHz mono (by running the
// AudioContext at 16 kHz so Chromium does the resampling), and streams raw
// float32 frames to the main process, which feeds them to the sherpa-onnx
// keyword spotter. Capturing here (not in main) is required because Web Audio
// / getUserMedia only exist in a renderer.
//
// Main controls capture via start/stop and a pause/resume pair (capture is
// paused while the pet is actively recording a question, so the wake engine
// never hears — and re-triggers on — the user's own speech, and the chat
// recorder gets the mic to itself).

const TARGET_RATE = 16000;
const FRAME = 2048; // ScriptProcessor buffer (~128ms at 16k); power of two

let ctx = null;
let stream = null;
let node = null;
let source = null;
let paused = false;
let running = false;

async function startCapture() {
  if (running) return;
  running = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Asking for 16 kHz makes Chromium resample the mic for us — the frames
    // handed to onaudioprocess are already at TARGET_RATE.
    ctx = new AudioContext({ sampleRate: TARGET_RATE });
    source = ctx.createMediaStreamSource(stream);
    // 1 in / 1 out: the output buffer is left untouched (silent); we only read
    // the input. A node must be connected to destination to be pulled.
    node = ctx.createScriptProcessor(FRAME, 1, 1);
    node.onaudioprocess = (e) => {
      if (paused) return;
      const ch = e.inputBuffer.getChannelData(0);
      // Copy out of the recycled buffer before handing it across the bridge.
      window.listener.audio(new Float32Array(ch));
    };
    source.connect(node);
    node.connect(ctx.destination); // silent output; keeps the processor firing
    window.listener.ready(true);
  } catch (err) {
    running = false;
    window.listener.ready(false, String(err && err.message));
  }
}

function stopCapture() {
  running = false;
  try {
    if (node) node.disconnect();
    if (source) source.disconnect();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
  } catch (_) {
    /* tearing down; ignore */
  }
  node = source = stream = ctx = null;
}

window.listener.onStart(() => startCapture());
window.listener.onStop(() => stopCapture());
window.listener.onPause((on) => {
  paused = !!on;
});
