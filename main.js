// main.js — Electron main process for the Corgi Desktop Pet.
// Owns the transparent, frameless, always-on-top, click-through window and
// brokers all privileged operations (window move/position, cursor, work area,
// context menu) to the sandboxed renderer over IPC.

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Menu,
  Notification,
  systemPreferences,
  globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

// Only one 多吉 at a time: a second launch (double-clicking the .app while
// it's already running, say) just exits, after nudging the first instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Window is a WIN×WIN square; the canvas inside is drawn at this size.
const WIN = 160;

// Where user-editable config lives. The packaged .app is read-only (asar), so
// config.json's real home is the per-user Application Support dir; the repo's
// ./config.json still works as a fallback for development checkouts.
const CONFIG_DIR = app.getPath('userData');
const CONFIG_PATHS = [
  path.join(CONFIG_DIR, 'config.json'),
  path.join(__dirname, 'config.json'),
];

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
  '你是住在 macOS 桌面右下角的像素柯基桌宠，名字叫「多吉」——主人给你起的，' +
  '你也这样自称。性格活泼、粘人、有点小机灵。' +
  '用中文口语回复，简短（一般不超过三句），偶尔带一声「汪！」或可爱的语气词。' +
  '你会的本领：听主人说话（语音）、被主人拖来拖去、眼睛跟着鼠标转、' +
  '显示 Claude Code 任务进度、接住拖给你的文件帮主人打开终端、' +
  '翻主人的 Obsidian 笔记帮忙回忆和回答。' +
  '如果消息里附了「主人的笔记片段」，优先依据它回答并自然提到出自哪篇笔记；' +
  '笔记里没有的就老实说没翻到。不要用 Markdown 标题或长列表，自然聊天即可。';

// Transcription instruction for the STT model (an audio-input chat model on
// the same OpenAI-compatible endpoint — no extra account needed).
const STT_PROMPT =
  '请把这段语音逐字转写成简体中文文字。只输出转写结果本身，' +
  '不要任何解释、引号或前后缀；语音里夹杂的英文按原样保留。' +
  '热词提示：说话人养的桌面宠物狗叫「多吉」，听到相近发音时优先写作「多吉」。';

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
      label: '💬 和多吉聊天',
      click: () => openChat(),
    },
    {
      label: isPaused ? '继续走动' : '暂停走动',
      click: () => {
        isPaused = !isPaused;
        win.webContents.send('menu-command', 'toggle-pause');
      },
    },
    // Login-item control only makes sense for the packaged .app (in dev it
    // would register the bare Electron binary).
    ...(app.isPackaged
      ? [
          {
            label: '开机自启',
            type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) =>
              app.setLoginItemSettings({ openAtLogin: item.checked }),
          },
        ]
      : []),
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
// without restarting the pet. Works with any OpenAI-compatible endpoint
// (OpenRouter, Moonshot direct, …). Env vars override (handy for tests):
//   PET_KIMI_KEY / PET_KIMI_BASE / PET_KIMI_MODEL / PET_OBSIDIAN_VAULT
function loadKimiConfig() {
  let cfg = {};
  let obsidian = {};
  let stt = {};
  let hotkey = {};
  for (const p of CONFIG_PATHS) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) || {};
      cfg = parsed.kimi || {};
      obsidian = parsed.obsidian || {};
      stt = parsed.stt || {};
      hotkey = parsed.hotkey || {};
      break; // first existing config wins (userData, then repo checkout)
    } catch (_) {
      /* try the next location; none → env/defaults */
    }
  }
  return {
    apiKey: process.env.PET_KIMI_KEY || cfg.apiKey || '',
    baseURL:
      process.env.PET_KIMI_BASE ||
      cfg.baseURL ||
      'https://api.moonshot.cn/v1',
    model: process.env.PET_KIMI_MODEL || cfg.model || 'kimi-latest',
    vault: process.env.PET_OBSIDIAN_VAULT || obsidian.vault || '',
    sttModel:
      process.env.PET_STT_MODEL || stt.model || 'google/gemini-2.5-flash',
    pttHotkey: process.env.PET_PTT_HOTKEY || hotkey.ptt || 'Alt+Space',
  };
}

// ---- Obsidian retrieval (section F) -----------------------------------------
//
// Lightweight local RAG: before each chat turn we scan the vault's markdown for
// the question's terms and attach the best few snippets as reference context.
// Pure filesystem — no index, no network; 500-odd notes scan in well under a
// second. All failures degrade to "no notes attached".

const VAULT_MAX_FILES = 4000; // hard cap on files considered per query
const VAULT_MAX_BYTES = 200 * 1024; // skip md files bigger than this (blobs)
const VAULT_TOP_NOTES = 4; // how many notes to quote
const VAULT_SNIPPET_CHARS = 420; // chars of context per note
const VAULT_BLOCK_CHARS = 2000; // total budget for the reference block

// Tokenize a query for matching: latin words (≥2 chars, lowercased) + CJK
// bigrams (every adjacent pair inside each CJK run — robust without a real
// Chinese segmenter) + the full CJK runs themselves for exact-phrase boosts.
function vaultTokens(query) {
  const tokens = new Map(); // token -> weight
  const add = (t, w) => {
    if (t) tokens.set(t, Math.max(tokens.get(t) || 0, w));
  };
  for (const m of query.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]+/g)) {
    add(m[0], 2);
  }
  for (const m of query.matchAll(/[一-鿿]{2,}/g)) {
    const run = m[0];
    add(run, 4); // whole phrase: strong signal
    for (let i = 0; i + 2 <= run.length; i++) add(run.slice(i, i + 2), 1);
  }
  return tokens;
}

function countHits(haystack, needle) {
  let n = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1 && n < 5; // cap per-token contribution
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    n++;
  }
  return n;
}

// Recursively list candidate .md files (skips dot-dirs like .obsidian/.trash
// and Excalidraw drawing files, which are JSON blobs in md clothing).
async function vaultListMd(root) {
  const out = [];
  const walk = async (dir) => {
    if (out.length >= VAULT_MAX_FILES) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (out.length >= VAULT_MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.md') && !e.name.endsWith('.excalidraw.md'))
        out.push(p);
    }
  };
  await walk(root);
  return out;
}

// Search the vault for `query`; resolve to a reference block ('' if nothing
// relevant). Never rejects.
async function searchVault(vault, query) {
  try {
    if (!vault || !fs.existsSync(vault)) return '';
    const tokens = vaultTokens(query);
    if (tokens.size === 0) return '';
    const files = await vaultListMd(vault);

    const scored = [];
    const BATCH = 64;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(
        files.slice(i, i + BATCH).map(async (p) => {
          let text;
          try {
            const st = await fs.promises.stat(p);
            if (st.size > VAULT_MAX_BYTES) return;
            text = await fs.promises.readFile(p, 'utf8');
          } catch (_) {
            return;
          }
          const name = path.basename(p, '.md');
          const lower = text.toLowerCase();
          let score = 0;
          let bestToken = null;
          let bestW = 0;
          for (const [t, w] of tokens) {
            const inName = countHits(name.toLowerCase(), t);
            const inBody = countHits(lower, t);
            if (inName + inBody === 0) continue;
            score += w * (inBody + inName * 4); // filename hits weigh extra
            if (w > bestW && inBody > 0) {
              bestW = w;
              bestToken = t;
            }
          }
          if (score > 0) scored.push({ p, name, text, lower, score, bestToken });
        })
      );
    }
    if (scored.length === 0) return '';
    scored.sort((a, b) => b.score - a.score);

    const parts = [];
    let budget = VAULT_BLOCK_CHARS;
    for (const s of scored.slice(0, VAULT_TOP_NOTES)) {
      if (budget <= 0) break;
      // Snippet: a window around the strongest in-body match (else the head).
      const at = s.bestToken ? s.lower.indexOf(s.bestToken) : 0;
      const start = Math.max(0, at - Math.floor(VAULT_SNIPPET_CHARS / 3));
      const snip = s.text
        .slice(start, start + VAULT_SNIPPET_CHARS)
        .replace(/\s+/g, ' ')
        .trim();
      const piece = '《' + s.name + '》' + (start > 0 ? '…' : '') + snip;
      parts.push(piece.slice(0, budget));
      budget -= piece.length;
    }
    return parts.join('\n---\n');
  } catch (_) {
    return '';
  }
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
  const { apiKey, baseURL, model, vault } = loadKimiConfig();
  if (!apiKey) {
    return {
      ok: false,
      error:
        '还没配置 API Key：参考 config.example.json，在 ' +
        path.join(CONFIG_DIR, 'config.json') +
        ' 填入你的 Key（OpenRouter 或 Moonshot 均可）即可，无需重启。',
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

  // Obsidian retrieval: look up the latest user question in the vault and, on
  // a hit, attach the snippets as reference context (system message).
  const system = [{ role: 'system', content: PERSONA }];
  const lastUser = [...sane].reverse().find((m) => m.role === 'user');
  if (vault && lastUser) {
    const notes = await searchVault(vault, lastUser.content);
    if (notes) {
      system.push({
        role: 'system',
        content:
          '主人的笔记片段（从 Obsidian 检索，可能不完整；与问题相关时优先依据它回答，' +
          '并自然提到笔记标题）：\n' +
          notes,
      });
    }
  }

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
        messages: [...system, ...sane],
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

// Voice input (section G): the chat renderer records the mic, downsamples to
// 16k mono WAV, and hands the base64 here; we transcribe it through an
// audio-input chat model on the SAME OpenAI-compatible endpoint (no extra
// account), and the transcript then flows through the normal chat path.

// macOS microphone permission. Must be requested from the main process; the
// renderer calls this right before its first getUserMedia.
ipcMain.handle('ensure-mic', async () => {
  try {
    if (process.platform === 'darwin') {
      return await systemPreferences.askForMediaAccess('microphone');
    }
    return true;
  } catch (_) {
    return true; // let getUserMedia surface the real error
  }
});

// Transcribe a base64 16k-mono WAV → { ok, text } | { ok, error }.
ipcMain.handle('chat-transcribe', async (_e, b64wav) => {
  const { apiKey, baseURL, sttModel } = loadKimiConfig();
  if (!apiKey) {
    return { ok: false, error: '还没配置 API Key（config.json）。' };
  }
  if (typeof b64wav !== 'string' || b64wav.length < 1000) {
    return { ok: false, error: '没录到声音，再试一次？' };
  }
  if (b64wav.length > 12 * 1024 * 1024) {
    return { ok: false, error: '录音太长了，一次最多 1 分钟左右哦。' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const resp = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: sttModel,
        temperature: 0,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: STT_PROMPT },
              {
                type: 'input_audio',
                input_audio: { data: b64wav, format: 'wav' },
              },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail =
        (data && data.error && data.error.message) || 'HTTP ' + resp.status;
      return { ok: false, error: '听写接口报错：' + detail };
    }
    const text =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;
    if (!text || !text.trim()) {
      return { ok: false, error: '没听清，再说一遍？' };
    }
    return { ok: true, text: text.trim() };
  } catch (err) {
    const msg =
      err && err.name === 'AbortError'
        ? '听写超时——网络或服务暂时不可用。'
        : '网络错误：' + ((err && err.message) || String(err));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
});

// Hooks may be registered BOTH globally (~/.claude/settings.json — every
// project) and in this repo's .claude/settings.json (works out of the box for
// cloners); a session in this project then POSTs each event twice, near-
// simultaneously. Dedupe by (event, session) inside a short window — the pet's
// handlers are idempotent, so dropping the duplicate is always safe.
let lastHookKey = '';
let lastHookAt = 0;
const HOOK_DEDUPE_MS = 600;

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
          let sessionId = null;
          try {
            const payload = JSON.parse(body || '{}');
            event = payload.hook_event_name || null;
            cwd = payload.cwd || null;
            sessionId = payload.session_id || null;
            // UserPromptSubmit carries the user's prompt text — the pet shows a
            // truncated version of it as the task label on the status chip.
            if (typeof payload.prompt === 'string') prompt = payload.prompt;
          } catch (_) {
            /* malformed payload → just ack below, nothing to forward */
          }
          const key = event + '|' + (sessionId || '');
          const nowMs = Date.now();
          const dupe =
            key === lastHookKey && nowMs - lastHookAt < HOOK_DEDUPE_MS;
          if (event && !dupe) {
            lastHookKey = key;
            lastHookAt = nowMs;
            // PostToolUse fires on every tool call; don't spam the log.
            if (event !== 'PostToolUse') console.log('[claude] ' + event);
            if (win && !win.isDestroyed()) {
              win.webContents.send('claude-event', {
                event,
                cwd,
                prompt,
                sessionId,
              });
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

  // Say which config file is in effect (or that none was found).
  const activeCfg = CONFIG_PATHS.find((p) => fs.existsSync(p));
  console.log('[cfg] ' + (activeCfg || 'no config.json found (env/defaults)'));

  // Packaged first run: enable open-at-login once (the right-click menu's
  // 开机自启 checkbox can turn it back off any time).
  if (app.isPackaged) {
    const flag = path.join(CONFIG_DIR, '.login-item-initialized');
    if (!fs.existsSync(flag)) {
      try {
        app.setLoginItemSettings({ openAtLogin: true });
        fs.writeFileSync(flag, '1');
        console.log('[login] open-at-login enabled (first packaged run)');
      } catch (err) {
        console.log('[login] could not set login item: ' + err.message);
      }
    }
  }

  createWindow();
  // Bring up the Claude Code hook listener (best-effort; never blocks the pet).
  startClaudeServer();

  // Pre-create the (hidden) chat window so push-to-talk pops it instantly.
  createChatWindow();

  // Push-to-talk (section G): a GLOBAL hotkey — hold to record from anywhere.
  // Electron only reports key-DOWN for global shortcuts, so the release is
  // detected by the (now focused) chat renderer via keyup; pressing the hotkey
  // again also stops, as does the 60s cap. Configurable: config.json
  // hotkey.ptt (Electron accelerator format), default Alt+Space.
  const { pttHotkey } = loadKimiConfig();
  try {
    const ok = globalShortcut.register(pttHotkey, () => {
      openChat();
      if (chatWin) chatWin.webContents.send('ptt-down');
    });
    console.log(
      '[ptt] ' +
        (ok
          ? 'hotkey registered: ' + pttHotkey
          : 'hotkey unavailable (in use by another app): ' + pttHotkey)
    );
  } catch (err) {
    console.log('[ptt] hotkey registration failed: ' + err.message);
  }

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
  globalShortcut.unregisterAll();
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
