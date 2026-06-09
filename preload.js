// preload.js — secure IPC bridge.
// Runs with contextIsolation ON, so the renderer never touches Node/ipcRenderer
// directly. We expose a small, explicit `window.pet` surface via contextBridge.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // Fire-and-forget commands -------------------------------------------------
  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore),
  moveTo: (x, y) => ipcRenderer.send('move-to', { x, y }),
  showMenu: () => ipcRenderer.send('show-menu'),
  quit: () => ipcRenderer.send('quit'),
  // Open a dropped file/folder in Terminal.app running Claude Code (section E).
  openInClaude: (p) => ipcRenderer.send('open-in-claude', p),

  // Request/response queries -------------------------------------------------
  getPos: () => ipcRenderer.invoke('get-pos'), // -> [x, y]
  getCursor: () => ipcRenderer.invoke('get-cursor'), // -> {x, y}
  getWorkArea: () => ipcRenderer.invoke('get-work-area'), // -> {x, y, width, height}
  // Resolve the absolute filesystem path of a dropped File (Electron 32+ no
  // longer exposes File.path; webUtils does the lookup from the trusted side).
  getPathForFile: (f) => webUtils.getPathForFile(f),

  // Main → renderer push -----------------------------------------------------
  onMenuCommand: (cb) => ipcRenderer.on('menu-command', (_e, c) => cb(c)),
  // Global cursor position in screen points, polled by main (~30 Hz). Drives
  // the resting dog's gaze tracking.
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, p) => cb(p)),
  // Claude Code hook events forwarded by main: { event, cwd } (section D).
  onClaudeEvent: (cb) => ipcRenderer.on('claude-event', (_e, d) => cb(d)),
});
