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
  // Open the chat panel (section F) — double-click on the body / context menu.
  openChat: () => ipcRenderer.send('open-chat'),

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
  // System file-drag started/ended anywhere on the machine (section E). The
  // pet keeps ignoring mouse events during the drag; the catcher window
  // shown at its bounds is what actually receives the drop.
  onDragMode: (cb) => ipcRenderer.on('drag-mode', (_e, on) => cb(on)),
  // Relayed from the catcher: a drag is hovering the dog (show the 📂 cue).
  onDropHover: (cb) => ipcRenderer.on('drop-hover', (_e, on) => cb(on)),
  // Relayed from the catcher: a file/folder was dropped on the dog.
  onDropPath: (cb) => ipcRenderer.on('drop-path', (_e, p) => cb(p)),
  // Wake word heard (section H): bark + perk up as acknowledgement.
  onWakeBark: (cb) => ipcRenderer.on('wake-bark', () => cb()),
  // Display sleep/wake reconcile: main pushes the window's true (clamped)
  // position so the renderer re-homes there, fixing post-unlock drift.
  onResyncPos: (cb) => ipcRenderer.on('resync-pos', (_e, p) => cb(p)),
  // Screen locked/asleep (true) or woken (false): pause/resume wandering so the
  // dog doesn't roam blind against a stale work area while the screen is off.
  onPowerSleep: (cb) => ipcRenderer.on('power-sleep', (_e, on) => cb(on)),
});
