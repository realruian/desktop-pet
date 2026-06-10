// preload-chat.js — secure IPC bridge for the chat panel (section F).
// Same model as preload.js: contextIsolation ON, a tiny explicit surface.
// The Kimi API key never reaches this renderer — requests run in main.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chat', {
  // Send the conversation (array of {role, content}) to Kimi via main.
  // Resolves to { ok: true, content } or { ok: false, error }.
  send: (messages) => ipcRenderer.invoke('chat-send', messages),
  // Transcribe a base64 16k-mono WAV (voice input, section G).
  // Resolves to { ok: true, text } or { ok: false, error }.
  transcribe: (b64wav) => ipcRenderer.invoke('chat-transcribe', b64wav),
  // Ask macOS for microphone permission (must run in main).
  ensureMic: () => ipcRenderer.invoke('ensure-mic'),
  // Hide the panel (✕ button / Esc).
  hide: () => ipcRenderer.send('chat-hide'),
});
