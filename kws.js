// kws.js — offline wake-word ("河马河马") engine, main-process side (section H).
//
// Wraps sherpa-onnx-node's KeywordSpotter. Audio is captured by the hidden
// listener renderer (Web Audio can't run in main), downsampled to 16 kHz mono
// float32 there, and streamed here frame-by-frame over IPC. We run the spotter
// and fire onWake() when the keyword is detected, fully on-device — no network,
// no API key, nothing leaves the machine.
//
// Everything is defensive: if the native module or model files are missing the
// engine just reports unavailable and the rest of the pet is unaffected.

const path = require('path');
const fs = require('fs');

const SAMPLE_RATE = 16000;
// Ignore repeat detections within this window so one "河马河马" fires once.
const REARM_MS = 2500;

class WakeEngine {
  constructor(opts) {
    this.opts = opts; // { modelDir, keywordsFile, threshold, score, onWake, log }
    this.kws = null;
    this.stream = null;
    this.available = false;
    this.lastFire = 0;
    this._log = opts.log || (() => {});
  }

  // Build the spotter. Returns true on success. Safe to call again to rebuild
  // (e.g. after a threshold change).
  start() {
    this.stop();
    const { modelDir, keywordsFile, threshold, score } = this.opts;
    try {
      const sherpa = require('sherpa-onnx-node');
      const need = ['encoder.int8.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'];
      for (const f of need) {
        if (!fs.existsSync(path.join(modelDir, f))) {
          this._log('[kws] missing model file: ' + f + ' — wake disabled');
          return false;
        }
      }
      if (!fs.existsSync(keywordsFile)) {
        this._log('[kws] missing keywords file — wake disabled');
        return false;
      }
      this.kws = new sherpa.KeywordSpotter({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: path.join(modelDir, 'encoder.int8.onnx'),
            decoder: path.join(modelDir, 'decoder.onnx'),
            joiner: path.join(modelDir, 'joiner.onnx'),
          },
          tokens: path.join(modelDir, 'tokens.txt'),
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        maxActivePaths: 4,
        numTrailingBlanks: 1,
        keywordsScore: typeof score === 'number' ? score : 2.0,
        keywordsThreshold: typeof threshold === 'number' ? threshold : 0.2,
        keywordsFile,
      });
      this.stream = this.kws.createStream();
      this.available = true;
      this._log('[kws] wake engine ready (threshold=' + this.opts.threshold + ')');
      return true;
    } catch (err) {
      this._log('[kws] unavailable: ' + (err && err.message));
      this.kws = null;
      this.stream = null;
      this.available = false;
      return false;
    }
  }

  // Feed one chunk of 16 kHz mono float32 PCM. Drains the decoder and fires
  // onWake (debounced) on a keyword hit.
  feed(samples) {
    if (!this.available || !this.stream) return;
    try {
      this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      while (this.kws.isReady(this.stream)) {
        this.kws.decode(this.stream);
        const r = this.kws.getResult(this.stream);
        if (r && r.keyword) {
          this.kws.reset(this.stream);
          const now = Date.now();
          if (now - this.lastFire >= REARM_MS) {
            this.lastFire = now;
            this._log('[kws] WAKE: ' + r.keyword);
            try {
              this.opts.onWake(r.keyword);
            } catch (_) {
              /* never let a handler error kill the audio pump */
            }
          }
        }
      }
    } catch (err) {
      this._log('[kws] feed error: ' + (err && err.message));
    }
  }

  stop() {
    // Drop references; the native objects are GC-finalized. A fresh createStream
    // happens on the next start().
    this.stream = null;
    this.kws = null;
    this.available = false;
  }
}

module.exports = { WakeEngine, SAMPLE_RATE };
