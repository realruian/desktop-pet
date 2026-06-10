// preload-chat.js — secure IPC bridge for the chat panel (section F).
// Same model as preload.js: contextIsolation ON, a tiny explicit surface.
// The Kimi API key never reaches this renderer — requests run in main.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chat', {
  // Send the conversation (array of {role, content}) to Kimi via main.
  // Resolves to { ok: true, content } or { ok: false, error }.
  send: (messages) => ipcRenderer.invoke('chat-send', messages),
  // Hide the panel (✕ button / Esc).
  hide: () => ipcRenderer.send('chat-hide'),
});
