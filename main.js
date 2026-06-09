// main.js — Electron main process for the Corgi Desktop Pet.
// Owns the transparent, frameless, always-on-top, click-through window and
// brokers all privileged operations (window move/position, cursor, work area,
// context menu) to the sandboxed renderer over IPC.

const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');

// Window is a WIN×WIN square; the canvas inside is drawn at this size.
const WIN = 200;

/** @type {BrowserWindow|null} */
let win = null;

// Tracks the menu toggle label state ("paused" vs "walking"). The actual
// behavior pause lives in the renderer; this only drives the menu text.
let isPaused = false;

// Cursor polling: feed the renderer the global cursor position so the resting
// dog's eyes can track it. setInterval id (cleared on window close).
let cursorTimer = null;
// Last position we pushed; skip identical sends to keep IPC quiet.
let lastSentCursor = { x: null, y: null };
const CURSOR_POLL_MS = 33; // ~30 Hz, matches the eyes' per-frame recompute

function createWindow() {
  win = new BrowserWindow({
    width: WIN,
    height: WIN,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Float above normal windows and follow the user across spaces / fullscreen apps.
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Start fully click-through. `forward:true` keeps mousemove events flowing to
  // the renderer so it can run the pixel-perfect hover hit-test and toggle this
  // back off when the cursor is genuinely over the dog's body.
  win.setIgnoreMouseEvents(true, { forward: true });

  // Initial position: bottom-right of the primary display's work area.
  const wa = screen.getPrimaryDisplay().workArea;
  const x = wa.x + wa.width - WIN - 40;
  const y = wa.y + wa.height - WIN - 30;
  win.setPosition(x, y);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Start cursor polling only once the renderer is up and listening, so early
  // 'cursor' sends aren't dropped. Poll the global cursor position and forward
  // it; skip sends when it hasn't moved.
  win.webContents.on('did-finish-load', () => {
    if (cursorTimer) clearInterval(cursorTimer);
    cursorTimer = setInterval(() => {
      if (!win) return;
      const { x, y } = screen.getCursorScreenPoint();
      if (x === lastSentCursor.x && y === lastSentCursor.y) return;
      lastSentCursor = { x, y };
      win.webContents.send('cursor', { x, y });
    }, CURSOR_POLL_MS);
  });

  win.on('closed', () => {
    if (cursorTimer) {
      clearInterval(cursorTimer);
      cursorTimer = null;
    }
    win = null;
  });
}

// ---- IPC: privileged operations requested by the renderer -------------------

// Toggle click-through. Always keep forwarding so mousemove keeps arriving.
ipcMain.on('set-ignore', (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
});

// Move the window's top-left corner (screen points). Used for both dragging
// and the wander AI.
ipcMain.on('move-to', (_e, { x, y }) => {
  if (win) win.setPosition(Math.round(x), Math.round(y));
});

// Current window top-left → [x, y].
ipcMain.handle('get-pos', () => (win ? win.getPosition() : [0, 0]));

// Global cursor position in screen points → {x, y}.
ipcMain.handle('get-cursor', () => screen.getCursorScreenPoint());

// Work area of whichever display currently contains the window → {x,y,width,height}.
ipcMain.handle('get-work-area', () =>
  screen.getDisplayMatching(win.getBounds()).workArea
);

// Right-click context menu, built and popped up by the main process.
ipcMain.on('show-menu', () => {
  if (!win) return;
  const menu = Menu.buildFromTemplate([
    {
      label: isPaused ? '继续走动' : '暂停走动',
      click: () => {
        isPaused = !isPaused;
        win.webContents.send('menu-command', 'toggle-pause');
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ]);
  menu.popup({ window: win });
});

ipcMain.on('quit', () => app.quit());

// ---- App lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  // Headless dock: this is an overlay pet, not a normal app window.
  app.dock?.hide();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed (overlay pet has no reason to linger).
app.on('window-all-closed', () => {
  app.quit();
});
