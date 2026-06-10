// main.js — Electron main process for the Corgi Desktop Pet.
// Owns the transparent, frameless, always-on-top, click-through window and
// brokers all privileged operations (window move/position, cursor, work area,
// context menu) to the sandboxed renderer over IPC.

const { app, BrowserWindow, ipcMain, screen, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

// Window is a WIN×WIN square; the canvas inside is drawn at this size.
const WIN = 160;

// Loopback port for the Claude Code hook server (section D). Claude Code's hooks
// POST their JSON payloads here; we forward the event to the renderer so the pet
// can reflect working/waiting/done. Best-effort: if the port is busy the pet
// still works without the integration.
const CLAUDE_PORT = 4319;

/** @type {BrowserWindow|null} */
let win = null;

// Tracks the menu toggle label state ("paused" vs "walking"). The actual
// behavior pause lives in the renderer; this only drives the menu text.
let isPaused = false;

// Claude Code hook server (section D). Held so we can close it on quit.
/** @type {import('http').Server|null} */
let claudeServer = null;

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

  // Pin above EVERYTHING: 'screen-saver' is the highest practical macOS window
  // level, so the pet stays visible over normal apps, floating palettes and
  // fullscreen apps alike, and follows the user across spaces.
  win.setAlwaysOnTop(true, 'screen-saver');
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

// Drop a file/folder on the dog → open Terminal.app in that directory running
// `claude` (section E). All failures are caught and logged; the pet never crashes.
ipcMain.on('open-in-claude', (_e, p) => {
  try {
    if (typeof p !== 'string' || !p) return;
    const st = fs.statSync(p); // throws if the path is gone → caught below
    let dir;
    let file = null;
    if (st.isDirectory()) {
      dir = p;
    } else {
      dir = path.dirname(p);
      file = path.basename(p);
    }

    // Shell-quote the directory: wrap in single quotes, escaping any embedded
    // single quote as the classic '\'' sequence. Safe for the `do script` shell.
    const shellQuoted = "'" + dir.replace(/'/g, "'\\''") + "'";
    // The shell command Terminal will run.
    const command = 'cd ' + shellQuoted + ' && claude';
    // Embed that command as an AppleScript string literal: escape \ then ".
    const asLiteral = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script =
      'tell application "Terminal"\n' +
      '  activate\n' +
      '  do script "' + asLiteral + '"\n' +
      'end tell';

    // Lets tests inspect the exact AppleScript without launching Terminal.
    if (process.env.PET_LOG_OSA) console.log(script);

    execFile('osascript', ['-e', script], (err) => {
      if (err) {
        console.log('[claude] open-in-claude osascript failed: ' + err.message);
        return;
      }
      // If a FILE was dropped, best-effort prefill the prompt with `@<file> `
      // (no Return). Needs Accessibility permission for System Events; wrap in
      // `try` so a missing permission can't break the (already successful) open.
      if (file) {
        const fileLiteral = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const keystrokeScript =
          'try\n' +
          '  tell application "System Events" to keystroke "@' +
          fileLiteral +
          ' "\n' +
          'end try';
        if (process.env.PET_LOG_OSA) console.log(keystrokeScript);
        // Small delay so the new Terminal tab is focused before we type.
        setTimeout(() => {
          execFile('osascript', ['-e', keystrokeScript], (kErr) => {
            if (kErr) {
              console.log(
                '[claude] open-in-claude prefill failed: ' + kErr.message
              );
            }
          });
        }, 700);
      }
    });
  } catch (err) {
    console.log('[claude] open-in-claude error: ' + err.message);
  }
});

// ---- Claude Code hook server (section D) ------------------------------------
//
// A tiny loopback HTTP listener. This project's Claude Code hooks POST their
// JSON payloads to /hook; we parse the event, forward it to the renderer, and
// pop a native notification on completion. Entirely best-effort: any failure
// (port busy, bad payload, …) is logged once and ignored so the pet keeps
// working without the integration.

function startClaudeServer() {
  try {
    claudeServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/hook') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          let event = null;
          let cwd = null;
          let prompt = null;
          try {
            const payload = JSON.parse(body || '{}');
            event = payload.hook_event_name || null;
            cwd = payload.cwd || null;
            // UserPromptSubmit carries the user's prompt text — the pet shows a
            // truncated version of it as the task label on the status chip.
            if (typeof payload.prompt === 'string') prompt = payload.prompt;
          } catch (_) {
            /* malformed payload → just ack below, nothing to forward */
          }
          if (event) {
            // PostToolUse fires on every tool call (it drives the pet's mini
            // progress bar); don't spam the log with each one.
            if (event !== 'PostToolUse') console.log('[claude] ' + event);
            if (win && !win.isDestroyed()) {
              win.webContents.send('claude-event', { event, cwd, prompt });
            }
            // Native notification on task completion.
            if (event === 'Stop' && Notification.isSupported()) {
              const proj = cwd ? path.basename(cwd) : 'Claude Code';
              new Notification({ title: '✅ 任务完成', body: proj }).show();
            } else if (event === 'Notification' && Notification.isSupported()) {
              new Notification({
                title: 'Claude Code',
                body: 'Claude 在等你…',
              }).show();
            }
          }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        });
        return;
      }
      // Any other route → 200 'ok'.
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    // A busy port (another pet instance, say) must not be fatal.
    claudeServer.on('error', (err) => {
      console.log('[claude] hook server unavailable: ' + err.message);
      claudeServer = null;
    });

    claudeServer.listen(CLAUDE_PORT, '127.0.0.1', () => {
      console.log('[claude] hook server listening on 127.0.0.1:' + CLAUDE_PORT);
    });
  } catch (err) {
    console.log('[claude] hook server failed to start: ' + err.message);
    claudeServer = null;
  }
}

// ---- App lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  // Headless dock: this is an overlay pet, not a normal app window.
  app.dock?.hide();
  createWindow();
  // Bring up the Claude Code hook listener (best-effort; never blocks the pet).
  startClaudeServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Tear down the hook server on quit so the port is released cleanly.
app.on('will-quit', () => {
  if (claudeServer) {
    try {
      claudeServer.close();
    } catch (_) {
      /* already closing/closed */
    }
    claudeServer = null;
  }
});

// Quit when all windows are closed (overlay pet has no reason to linger).
app.on('window-all-closed', () => {
  app.quit();
});
