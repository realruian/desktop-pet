// preload-catcher.js — bridge for the invisible drop-catcher window (section E).
// The catcher only needs to report drag hover, resolve dropped paths, and hand
// the path to main; everything else (animation, Terminal launch) lives with
// the pet.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('catcher', {
  hover: (on) => ipcRenderer.send('catcher-hover', on),
  drop: (p) => ipcRenderer.send('catcher-drop', p),
  // Electron 32+ removed File.path; webUtils resolves it from the trusted side.
  getPathForFile: (f) => webUtils.getPathForFile(f),
});
