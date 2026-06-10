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

// Chat panel size (section F).
const CHAT_W = 300;
const CHAT_H = 400;

// The dog's persona for Kimi conversations (section F). Prepended as the
// system message on every request.
const PERSONA =
  '你是住在 macOS 桌面右下角的像素柯基桌宠。性格活泼、粘人、有点小机灵。' +
  '用中文口语回复，简短（一般不超过三句），偶尔带一声「汪！」或可爱的语气词。' +
  '你会的本领：被主人拖来拖去、眼睛跟着鼠标转、显示 Claude Code 任务进度、' +
  '接住拖给你的文件帮主人打开终端。不要用 Markdown 标题或长列表，自然聊天即可。';

/** @type {BrowserWindow|null} */
let win = null;

// Chat panel window (section F). Created lazily on first open; closing it just
// HIDES it so the conversation history survives reopening within a session.
/** @type {BrowserWindow|null} */
let chatWin = null;

// Set while the app is really quitting, so chatWin's close handler lets the
// window die instead of hiding it.
let isQuitting = false;

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
      label: '💬 聊天',
      click: () => openChat(),
    },
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

// ---- Kimi chat (section F) ---------------------------------------------------
//
// The pet can hold a conversation through Moonshot's Kimi API. The key lives in
// the gitignored local config.json (see config.example.json) and never leaves
// the main process; the chat renderer only ever sees message text.

// Read config.json fresh on every use, so filling in the API key takes effect
// without restarting the pet. Env vars override (handy for tests):
//   PET_KIMI_KEY / PET_KIMI_BASE / PET_KIMI_MODEL
function loadKimiConfig() {
  let cfg = {};
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    cfg = (JSON.parse(raw) || {}).kimi || {};
  } catch (_) {
    /* missing/malformed config.json → fall back to env/defaults */
  }
  return {
    apiKey: process.env.PET_KIMI_KEY || cfg.apiKey || '',
    baseURL:
      process.env.PET_KIMI_BASE ||
      cfg.baseURL ||
      'https://api.moonshot.cn/v1',
    model: process.env.PET_KIMI_MODEL || cfg.model || 'kimi-latest',
  };
}

function createChatWindow() {
  chatWin = new BrowserWindow({
    width: CHAT_W,
    height: CHAT_H,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: true,
    skipTaskbar: true,
    fullscreenable: false,
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-chat.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Same float-above-everything treatment as the pet (section: requirement 3).
  chatWin.setAlwaysOnTop(true, 'screen-saver');
  chatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  chatWin.loadFile(path.join(__dirname, 'renderer', 'chat.html'));

  // Closing hides (history survives); only a real quit destroys the window.
  chatWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      chatWin.hide();
    }
  });
  chatWin.on('closed', () => {
    chatWin = null;
  });
}

// Show the chat panel anchored to the pet: right-aligned with the dog, sitting
// just above it, clamped into the work area.
function openChat() {
  if (!chatWin) createChatWindow();
  if (win) {
    const [px, py] = win.getPosition();
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const x = Math.max(
      wa.x + 8,
      Math.min(px + WIN - CHAT_W, wa.x + wa.width - CHAT_W - 8)
    );
    const y = Math.max(wa.y + 8, py - CHAT_H - 6);
    chatWin.setPosition(Math.round(x), Math.round(y));
  }
  chatWin.show();
  chatWin.focus();
}

ipcMain.on('open-chat', openChat);

ipcMain.on('chat-hide', () => {
  if (chatWin) chatWin.hide();
});

// Round-trip one conversation to Kimi. `messages` is the renderer's history
// ({role:'user'|'assistant', content} only — we prepend the persona here).
// Resolves {ok:true, content} | {ok:false, error}; never throws to the caller.
ipcMain.handle('chat-send', async (_e, messages) => {
  const { apiKey, baseURL, model } = loadKimiConfig();
  if (!apiKey) {
    return {
      ok: false,
      error:
        '还没配置 Kimi API Key：把项目里的 config.example.json 复制为 ' +
        'config.json，填入你的 Moonshot Key（sk- 开头）即可，无需重启。',
    };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: '没有可发送的消息。' };
  }
  const sane = messages
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    )
    .map((m) => ({ role: m.role, content: m.content }));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: PERSONA }, ...sane],
        temperature: 0.6,
        max_tokens: 1024,
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail =
        (data && data.error && data.error.message) || 'HTTP ' + resp.status;
      return { ok: false, error: 'Kimi 接口报错：' + detail };
    }
    const content =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;
    if (!content) return { ok: false, error: 'Kimi 返回了空回复，再试一次？' };
    return { ok: true, content };
  } catch (err) {
    const msg =
      err && err.name === 'AbortError'
        ? '请求超时（30s）——网络或服务暂时不可用。'
        : '网络错误：' + ((err && err.message) || String(err));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
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

// Let the chat window's close handler know this close is for real.
app.on('before-quit', () => {
  isQuitting = true;
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
