// preload-listener.js — bridge for the hidden wake-word listener (section H).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('listener', {
  // Renderer → main: one 16 kHz mono float32 audio frame. ipcRenderer's
  // structured clone carries the typed array's buffer efficiently.
  audio: (frame) => ipcRenderer.send('wake-audio', frame),
  // Renderer → main: capture came up (ok) or failed (with reason).
  ready: (ok, reason) => ipcRenderer.send('wake-ready', { ok, reason }),

  // Main → renderer control.
  onStart: (cb) => ipcRenderer.on('wake-start', () => cb()),
  onStop: (cb) => ipcRenderer.on('wake-stop', () => cb()),
  onPause: (cb) => ipcRenderer.on('wake-pause', (_e, on) => cb(on)),
});
