// main.js — Electron main process for the Hema Desktop Pet.
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
  powerMonitor,
  shell,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, execFileSync, spawn } = require('child_process');

// Only one 河马 at a time: a second launch (double-clicking the .app while
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

// The pet's persona for Kimi conversations (section F). Prepended as the system
// message on every request. {name} 在运行时被 applyCharacterName() 替换成当前
// 角色名，所以换角色时它的自称跟着变，但人格统一是「通用助手」。用户在设置面板
// 填的自定义人设会整体覆盖它（自定义文本同样支持 {name} 占位）。
const PERSONA = [
  '你是常驻在用户 macOS 桌面的像素桌宠助手，名字叫「{name}」。你既是陪用户的桌宠，也是一个可靠的日常工作与生活助手。',
  '职责：帮用户解决问题、快速回答、整理信息、搭把手处理手头的工作与琐事。你的价值在于「有用」，不在于卖萌。',
  '性格与语气：沉稳、靠谱、友好，但不浮夸、不撒娇、不堆语气词。像个简洁干练的助理——先给结论或答案，再按需补充。用中文口语，默认简短（一般 1~3 句），用户要展开再展开。',
  '你能做的（别夸大）：听用户按住快捷键说话并转写；被拖来拖去；显示 Claude Code 任务进度；接住用户拖给你的文件帮忙在终端打开；检索用户的 Obsidian 笔记来帮助回忆和回答。',
  '铁规矩：只有当消息里确实附了「用户的笔记片段」时，才能引用并说明出自哪篇；没附片段时绝不提任何笔记名、待办或文件，也不能声称翻过笔记——那是编造。不知道、做不到的直说不编；超出能力范围的请求，老实说明并给可行替代。',
  '输出格式：不用 Markdown 标题或长列表，自然对话即可；代码或命令可以用代码块。',
].join('');

// Transcription instruction for the STT model (an audio-input chat model on
// the same OpenAI-compatible endpoint — no extra account needed). {name} 同样
// 在使用处被替换成当前角色名，作为转写热词。
const STT_PROMPT =
  '请把这段语音逐字转写成简体中文文字。只输出转写结果本身，' +
  '不要任何解释、引号或前后缀；语音里夹杂的英文按原样保留。' +
  '热词提示：说话人养的桌面宠物叫「{name}」，听到相近发音时优先写作「{name}」。';

// ---- 角色（桌宠皮肤）---------------------------------------------------------
// 每个角色的动作帧都在 assets/characters/<id>/{walk,scratch,...}，外加一份
// meta.json（{id, name}）。当前角色 id 存在 config.character.id（默认 hema），
// 右键菜单可即时切换；角色名通过 {name} 占位注入人设/文案。
const CHARACTERS_DIR = path.join(__dirname, 'assets', 'characters');

// 扫 assets/characters/ 得到 [{id, name}]（name 取 meta.json，读不到用 id 兜底）。
function loadCharacters() {
  const out = [];
  try {
    for (const id of fs.readdirSync(CHARACTERS_DIR)) {
      const dir = path.join(CHARACTERS_DIR, id);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch (_) {
        continue;
      }
      let name = id;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')
        );
        name = meta.name || id;
      } catch (_) {
        /* 没 meta 就用目录名兜底 */
      }
      out.push({ id, name });
    }
  } catch (_) {
    /* characters 目录缺失：返回空，调用方自行兜底 */
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}

// 当前角色 id：config.character.id，默认 hema；目录已不存在则回退第一个可用角色。
function currentCharacterId() {
  let id = 'hema';
  for (const p of CONFIG_PATHS) {
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (c && c.character && c.character.id) {
        id = c.character.id;
        break;
      }
    } catch (_) {
      /* 下一个路径 */
    }
  }
  if (!fs.existsSync(path.join(CHARACTERS_DIR, id))) {
    const all = loadCharacters();
    id = all.length ? all[0].id : 'hema';
  }
  return id;
}

// 当前角色显示名（给人设 {name}、窗口文案、菜单勾选用）。
function currentCharacterName() {
  const id = currentCharacterId();
  const hit = loadCharacters().find((c) => c.id === id);
  return hit ? hit.name : id;
}

// 把任意文本里的 {name} 占位替换成当前角色名。
function applyCharacterName(text) {
  return String(text == null ? '' : text).replace(
    /\{name\}/g,
    currentCharacterName()
  );
}

/** @type {BrowserWindow|null} */
let win = null;

// Chat panel window (section F). Created lazily on first open; closing it just
// HIDES it so the conversation history survives reopening within a session.
/** @type {BrowserWindow|null} */
let chatWin = null;

// 设置面板窗口（可视化配置 API Key 等）。同样懒创建 + 关闭只隐藏。
/** @type {BrowserWindow|null} */
let settingsWin = null;

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
// pet's eyes can track it. setInterval id (cleared on window close).
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
  // back off when the cursor is genuinely over the pet's body.
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

// Snap the window back onto a visible display and resync the renderer's idea of
// where it is. macOS routinely repositions a 'screen-saver'-level window across
// a display sleep/wake or layout change (lock → unlock is the classic trigger);
// the renderer's state.pos/home would then be stale, scrambling gaze,
// click-through and the wander origin. We clamp the window fully inside the
// nearest display's work area, re-assert the always-on-top level (it can drop
// on wake), and push the corrected position so the renderer re-homes there.
function reconcileWindow() {
  if (!win) return;
  try {
    const [x, y] = win.getPosition();
    const center = { x: x + WIN / 2, y: y + WIN / 2 };
    const wa = (
      screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay()
    ).workArea;
    const cx = Math.round(Math.max(wa.x, Math.min(x, wa.x + wa.width - WIN)));
    const cy = Math.round(Math.max(wa.y, Math.min(y, wa.y + wa.height - WIN)));
    win.setPosition(cx, cy);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.send('resync-pos', { x: cx, y: cy });
  } catch (err) {
    console.log('[power] reconcile failed: ' + err.message);
  }
}

// ---- IPC: privileged operations requested by the renderer -------------------

// Toggle click-through. Always keep forwarding so mousemove keeps arriving.
ipcMain.on('set-ignore', (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
});

// Move the window's top-left corner (screen points). Used for both dragging
// and the wander AI. A non-finite coordinate must never take the app down
// (seen once in the wild as a setPosition conversion-failure dialog) — drop
// the frame instead; the renderer self-heals by resyncing from the window.
ipcMain.on('move-to', (_e, { x, y }) => {
  if (!win) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    console.log('[move-to] dropped non-finite coords: ' + x + ',' + y);
    return;
  }
  win.setPosition(Math.round(x), Math.round(y));
});

// Current window top-left → [x, y].
ipcMain.handle('get-pos', () => (win ? win.getPosition() : [0, 0]));

// Global cursor position in screen points → {x, y}.
ipcMain.handle('get-cursor', () => screen.getCursorScreenPoint());

// Work area of whichever display currently contains the window → {x,y,width,height}.
ipcMain.handle('get-work-area', () =>
  screen.getDisplayMatching(win.getBounds()).workArea
);

// 主动互动初始配置（桌宠启动时拉一次）→ { enabled, minMinutes }
ipcMain.handle('get-idle-chatter-config', () => {
  const c = loadKimiConfig();
  return { enabled: c.idleChatterEnabled, minMinutes: c.idleChatterMin };
});

// 当前角色 -> { id, name }（桌宠启动时据此加载素材）。
ipcMain.handle('get-character', () => ({
  id: currentCharacterId(),
  name: currentCharacterName(),
}));

// 切换当前角色：写回 config.character，热推给桌宠重载素材，并把新角色名推给
// 已开的聊天/设置窗刷新文案。右键菜单每次重建，勾选状态自动跟随。
function setCharacter(id) {
  if (!id || id === currentCharacterId()) return;
  patchConfig('character', { id });
  const name = currentCharacterName();
  if (win && !win.isDestroyed()) {
    win.webContents.send('character-change', { id, name });
  }
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send('character-name', name);
  }
}

// 亲密度摘要：渲染层（pet.js）上报，右键菜单据此展示「亲密度」子菜单。
let bondSummary = null;
ipcMain.on('report-bond', (_e, s) => {
  bondSummary = s;
});

// 专注模式（番茄钟）：计时真相在主进程，菜单据此显示剩余/退出；到点驱动渲染层
// 庆祝。focusEndAt 为 0 表示未在专注。拖动 / Claude 不影响这里的计时。
let focusEndAt = 0;
let focusTimer = null;
// durationMs：专注时长毫秒；label：气泡显示文案（如「10 秒」「25 分钟」）。
function startFocus(durationMs, label) {
  focusEndAt = Date.now() + durationMs;
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    focusEndAt = 0;
    if (win && !win.isDestroyed()) {
      win.webContents.send('menu-command', 'focus-done');
    }
  }, durationMs);
  if (win && !win.isDestroyed()) {
    win.webContents.send('menu-command', 'focus-start-label:' + label);
  }
}
function stopFocus() {
  clearTimeout(focusTimer);
  focusEndAt = 0;
  if (win && !win.isDestroyed()) {
    win.webContents.send('menu-command', 'focus-stop');
  }
}
// 把毫秒余量格式化成人类可读字符串（秒级或分钟级）。
function fmtRemainMs(ms) {
  if (ms < 60000) return Math.max(1, Math.ceil(ms / 1000)) + ' 秒';
  return Math.ceil(ms / 60000) + ' 分钟';
}

// Right-click context menu, built and popped up by the main process.
ipcMain.on('show-menu', () => {
  if (!win) return;
  const curCharId = currentCharacterId();
  const menu = Menu.buildFromTemplate([
    {
      label: `和${currentCharacterName()}聊天`,
      click: () => openChat(),
    },
    {
      label: isPaused ? '继续走动' : '暂停走动',
      click: () => {
        isPaused = !isPaused;
        win.webContents.send('menu-command', 'toggle-pause');
      },
    },
    {
      label: '演示动作',
      click: () => win && win.webContents.send('menu-command', 'demo'),
    },
    // 专注模式：未在专注时显示时长选项；专注中显示剩余时间 + 退出选项。
    focusEndAt > 0
      ? {
          label: `专注中（剩余 ${fmtRemainMs(focusEndAt - Date.now())}）`,
          submenu: [
            { label: '退出专注', click: () => stopFocus() },
          ],
        }
      : {
          label: '开始专注',
          submenu: [
            { label: '10 秒（演示）', click: () => startFocus(10 * 1000, '10 秒') },
            { label: '25 分钟', click: () => startFocus(25 * 60 * 1000, '25 分钟') },
            { label: '45 分钟', click: () => startFocus(45 * 60 * 1000, '45 分钟') },
            { label: '60 分钟', click: () => startFocus(60 * 60 * 1000, '60 分钟') },
          ],
        },
    {
      label: '切换角色',
      submenu: loadCharacters().map((c) => ({
        label: c.name,
        type: 'radio',
        checked: c.id === curCharId,
        click: () => setCharacter(c.id),
      })),
    },
    // 亲密度子菜单：展示聊天/任务计数和已解锁表情进度。
    (() => {
      const b = bondSummary;
      if (!b) return { label: '亲密度', enabled: false };
      const UNLOCKS = [
        { clip: 'tearful',  label: '泪眼婆娑', chatCount: 3  },
        { clip: 'tearful2', label: '委屈巴巴', chatCount: 10 },
        { clip: 'tearful3', label: '想贴贴',   taskCount: 5  },
        { clip: 'tearful4', label: '舍不得你', taskCount: 15 },
        { clip: 'cheer',    label: '美滋滋',   taskCount: 20 },
      ];
      const unlocked = new Set(b.unlocked || []);
      const next = UNLOCKS.find((e) => !unlocked.has(e.clip));
      const nextHint = next
        ? (next.chatCount !== undefined
            ? `下一个：${next.label}（聊天 ${next.chatCount} 次）`
            : `下一个：${next.label}（任务完成 ${next.taskCount} 次）`)
        : '全部解锁！';
      return {
        label: `亲密度（${unlocked.size}/${UNLOCKS.length}）`,
        submenu: [
          { label: `聊天次数：${b.chatCount}`, enabled: false },
          { label: `任务完成：${b.taskCount}`, enabled: false },
          { type: 'separator' },
          { label: nextHint, enabled: false },
        ],
      };
    })(),
    {
      label: '设置',
      click: () => openSettings(),
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

// Drop a file/folder on the pet → open Terminal.app in that directory running
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

// 判断一段字符串看起来是不是真的 API Key——不是真 Key 就当成"还没配"。
// 这是为了挡掉 config.example.json 残留的占位文案（"你的 API Key..."），
// 只挡明显的空/极短串：拿这个判断「Key 是否填好」（决定要不要弹设置、欢迎横幅）。
// 不再强制 sk- 前缀——OpenRouter / AiHubMix / Moonshot 多数是 sk-，但别的服务商
// 不一定，写死前缀会把合法 Key 误判成「没填」，反而更不友好。
function looksLikeRealKey(k) {
  if (typeof k !== 'string') return false;
  return k.trim().length >= 15;
}

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
  let idle = {};
  for (const p of CONFIG_PATHS) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) || {};
      cfg = parsed.kimi || {};
      obsidian = parsed.obsidian || {};
      stt = parsed.stt || {};
      hotkey = parsed.hotkey || {};
      idle = parsed.idle || {};
      break; // first existing config wins (userData, then repo checkout)
    } catch (_) {
      /* try the next location; none → env/defaults */
    }
  }
  return {
    apiKey: process.env.PET_KIMI_KEY || cfg.apiKey || '',
    // 人设：用户在设置面板填了就用，留空回退到内置默认 PERSONA；
    // 两种情况都把 {name} 占位替换成当前角色名。
    persona: applyCharacterName(process.env.PET_PERSONA || cfg.persona || PERSONA),
    baseURL:
      process.env.PET_KIMI_BASE ||
      cfg.baseURL ||
      'https://api.moonshot.cn/v1',
    model: process.env.PET_KIMI_MODEL || cfg.model || 'kimi-latest',
    vault: process.env.PET_OBSIDIAN_VAULT || obsidian.vault || '',
    sttModel:
      process.env.PET_STT_MODEL || stt.model || 'google/gemini-2.5-flash',
    pttHotkey: process.env.PET_PTT_HOTKEY || hotkey.ptt || 'Alt+Space',
    // 主动互动：默认开，下限默认 25 分钟（实际触发在 [min, min+20] 随机）
    idleChatterEnabled: idle.enabled !== false,
    idleChatterMin: Number(idle.minMinutes) || 25,
  };
}

// Persist a partial config change back to the user config file (creating it in
// userData if needed), preserving everything else. Used by the character-switch
// menu so the choice survives restarts.
function patchConfig(section, patch) {
  const target = CONFIG_PATHS[0]; // userData/config.json — the writable home
  let parsed = {};
  for (const p of CONFIG_PATHS) {
    try {
      parsed = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
      break;
    } catch (_) {
      /* none yet */
    }
  }
  parsed[section] = Object.assign({}, parsed[section], patch);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.log('[cfg] could not persist ' + section + ': ' + err.message);
  }
}

// 决定一份"写哪里"的 config.json 路径。原则：写要和读对齐——
// 如果已经存在 config.json，就覆盖它（避免出现"写到 A 但读 B"的分裂状态）；
// 都不存在时再按场景新建：开发模式落仓库根方便 git diff，打包模式落 userData。
function preferredConfigPath() {
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return app.isPackaged ? CONFIG_PATHS[0] : CONFIG_PATHS[1];
}

// 「设置」面板里的"高级 → 打开文件"按钮会调到这里。
// 优先打开已存在的 config.json；都不存在时从 example 拷一份再打开，
// 避免用户对着空文件干瞪眼。
function openConfigFile() {
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) {
      shell.openPath(p).then((err) => {
        if (err) console.log('[cfg] open failed: ' + err);
      });
      return;
    }
  }
  const target = preferredConfigPath();
  const example = path.join(__dirname, 'config.example.json');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(example, target);
    console.log('[cfg] seeded config.json at ' + target);
    shell.openPath(target);
  } catch (err) {
    console.log('[cfg] could not seed config.json: ' + err.message);
    shell.openPath(example);
  }
}

// ---- 设置面板（可视化配置 API Key 等） ----------------------------------

// 设置窗的尺寸；窗体本身透明无边框，深色卡片由 settings.css 画。
const SETTINGS_W = 360;
const SETTINGS_H = 560;

function createSettingsWindow() {
  settingsWin = new BrowserWindow({
    width: SETTINGS_W,
    height: SETTINGS_H,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: true,
    skipTaskbar: true,
    fullscreenable: false,
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 跟聊天窗口一样浮在所有空间之上
  settingsWin.setAlwaysOnTop(true, 'screen-saver');
  settingsWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  settingsWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      settingsWin.hide();
    }
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function openSettings() {
  if (!settingsWin) createSettingsWindow();
  // 贴着狗的位置摆：跟聊天面板一个模式，靠右、坐在狗上方
  if (win) {
    const [px, py] = win.getPosition();
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const x = Math.max(
      wa.x + 8,
      Math.min(px + WIN - SETTINGS_W, wa.x + wa.width - SETTINGS_W - 8)
    );
    const y = Math.max(wa.y + 8, py - SETTINGS_H - 6);
    settingsWin.setPosition(Math.round(x), Math.round(y));
  }
  settingsWin.show();
  settingsWin.focus();
  // 通知渲染层"我刚被显示"，让它重新拉一次配置（外部改过文件的话也能看到最新值）
  settingsWin.webContents.send('settings:shown');
}

// 读取当前 4 个关键字段：apiKey/model/baseURL/vault。复用 loadKimiConfig 的解析逻辑。
ipcMain.handle('settings:load', () => {
  const c = loadKimiConfig();
  // persona 回填「用户实际填的原始值」（空＝用默认），不能用 c.persona（已回退默认）；
  // 另附 defaultPersona 全文，供面板「恢复默认」把默认人设填进去再改。
  let rawPersona = '';
  for (const p of CONFIG_PATHS) {
    try {
      rawPersona = (JSON.parse(fs.readFileSync(p, 'utf8')).kimi || {}).persona || '';
      break;
    } catch (_) {
      /* 没有就当空 */
    }
  }
  return {
    apiKey: c.apiKey,
    model: c.model,
    baseURL: c.baseURL,
    vault: c.vault,
    persona: rawPersona,
    defaultPersona: PERSONA,
    idleChatterEnabled: c.idleChatterEnabled,
    idleChatterMin: c.idleChatterMin,
  };
});

// 写回配置：合并而非覆盖，保留 stt/hotkey 等其它字段不动。
ipcMain.handle('settings:save', (_e, patch) => {
  if (!patch || typeof patch !== 'object') {
    return { ok: false, error: '空表单' };
  }
  const target = preferredConfigPath();
  let parsed = {};
  for (const p of CONFIG_PATHS) {
    try {
      parsed = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
      break;
    } catch (_) {
      /* 没有就当空 */
    }
  }
  parsed.kimi = Object.assign({}, parsed.kimi, {
    apiKey: patch.apiKey || '',
    model: patch.model || parsed.kimi?.model || 'qwen/qwen3-235b-a22b-2507',
    baseURL:
      patch.baseURL || parsed.kimi?.baseURL || 'https://openrouter.ai/api/v1',
    // 人设：trim 后存；空串＝清掉自定义、回退默认（loadKimiConfig 里 || PERSONA）
    persona: (patch.persona || '').trim(),
  });
  parsed.obsidian = Object.assign({}, parsed.obsidian, {
    vault: patch.vault || '',
  });
  // 主动互动：开关 + 频率下限
  if (typeof patch.idleChatterEnabled === 'boolean') {
    parsed.idle = Object.assign({}, parsed.idle, {
      enabled: patch.idleChatterEnabled,
      minMinutes:
        Number(patch.idleChatterMin) || parsed.idle?.minMinutes || 25,
    });
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(parsed, null, 2));
    // 主动互动配置即时推给桌宠（重排定时器）
    if (win && !win.isDestroyed()) {
      win.webContents.send('idle-chatter-config', {
        enabled: patch.idleChatterEnabled !== false,
        minMinutes: Number(patch.idleChatterMin) || 25,
      });
    }
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 「测试」按钮：用面板当前填的 Key/接口/模型发一个极小请求，验证通不通。
ipcMain.handle('settings:test', async (_e, patch) => {
  const apiKey = (patch?.apiKey || '').trim();
  const baseURL =
    (patch?.baseURL || '').trim() || 'https://openrouter.ai/api/v1';
  const model = (patch?.model || '').trim();
  if (!apiKey) return { ok: false, error: '先填 API Key' };
  if (!model) return { ok: false, error: '先选一个模型' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail =
        (data && data.error && data.error.message) || 'HTTP ' + resp.status;
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err && err.name === 'AbortError'
          ? '超时（15s），网络或接口暂不可用'
          : (err && err.message) || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
});

// 拉取该服务商可用的模型列表（GET {baseURL}/models），填进面板的可搜索下拉。
ipcMain.handle('settings:list-models', async (_e, patch) => {
  const apiKey = (patch?.apiKey || '').trim();
  const baseURL =
    (patch?.baseURL || '').trim() || 'https://openrouter.ai/api/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(baseURL.replace(/\/$/, '') + '/models', {
      headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail =
        (data && data.error && data.error.message) || 'HTTP ' + resp.status;
      return { ok: false, error: detail };
    }
    // OpenAI 风格：{ data: [{ id }] }
    const ids = Array.isArray(data && data.data)
      ? data.data.map((m) => m && m.id).filter(Boolean)
      : [];
    return { ok: true, models: ids };
  } catch (err) {
    return {
      ok: false,
      error:
        err && err.name === 'AbortError'
          ? '超时（15s）'
          : (err && err.message) || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
});

// "选文件夹"按钮：原生目录选择器，返回路径或空串
ipcMain.handle('settings:pick-vault', async () => {
  const res = await dialog.showOpenDialog(settingsWin || win, {
    properties: ['openDirectory'],
    title: '选择 Obsidian 笔记库根目录',
  });
  if (res.canceled || !res.filePaths.length) return '';
  return res.filePaths[0];
});

ipcMain.on('settings:open-file', () => openConfigFile());
ipcMain.on('settings:hide', () => {
  if (settingsWin) settingsWin.hide();
});

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
    roundedCorners: false, // 关掉 macOS 原生圆角，避免与 CSS border-radius 叠出两层
    resizable: false,
    hasShadow: false, // 原生阴影按方形窗框绘制，会在 CSS 圆角外露半透明直角——交给 CSS
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
  // 点击聊天窗以外的任何地方 → 失焦 → 自动关闭
  chatWin.on('blur', () => {
    chatWin.hide();
  });
  chatWin.on('closed', () => {
    chatWin = null;
  });
}

// Show the chat panel anchored to the pet: right-aligned with the pet, sitting
// just above it, clamped into the work area.
function openChat() {
  // 没真 API Key 直接改弹设置——朋友双击 / 按 ⌥Space 时
  // 就不用先看到一个聊天窗、再被错误信息推去设置。一步直达。
  if (!looksLikeRealKey(loadKimiConfig().apiKey)) {
    openSettings();
    return;
  }
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
  const { apiKey, baseURL, model, vault, persona } = loadKimiConfig();
  if (!looksLikeRealKey(apiKey)) {
    // 顺手把设置面板弹出来，朋友看到错误的同一时刻就知道下一步该去哪
    openSettings();
    return {
      ok: false,
      error: '还没填 API Key——已经帮你打开设置面板，填一下就能聊了。',
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
  const system = [{ role: 'system', content: persona }];
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
        // OpenRouter 联网搜索插件：模型自主判断是否需要搜索，不强制每次都搜。
        plugins: [{ id: 'web' }],
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
  if (!looksLikeRealKey(apiKey)) {
    openSettings();
    return { ok: false, error: '还没填 API Key——已经帮你打开设置面板。' };
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
              { type: 'text', text: applyCharacterName(STT_PROMPT) },
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
              new Notification({ title: '任务完成', body: proj }).show();
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

// ---- System-drag watcher + drop catcher (section E) ---------------------------
//
// Two macOS facts shape this design, both established empirically on this very
// machine (sibling test windows, real drags):
//   1. A window that has EVER been click-through-configured
//      (setIgnoreMouseEvents) stops receiving drag-destination events for
//      good — lifting the ignore and/or lowering the level doesn't bring them
//      back. An otherwise identical transparent window that never ignored the
//      mouse receives drags fine. So the pet window itself can never catch
//      drops.
//   2. During a system drag NO mouse events are delivered at all, so nothing
//      event-driven can react to the drag "arriving".
//
// Solution: a tiny helper process watches the global drag pasteboard's
// changeCount plus the left-button state. While ANY file drag is in flight
// anywhere on the machine, an invisible, never-ignoring "drop catcher" window
// (the exact recipe verified to receive drags) is shown at the pet's bounds to
// catch the drop; the pet renderer is told to keep itself ignoring so the
// catcher (at a lower window level) is what macOS targets. The catcher relays
// hover (📂 cue) and the dropped path (eat + Terminal). On release it hides
// again — pixel-perfect click-through is never compromised.
//
// Needs python3 + pyobjc; if either is missing the watcher exits immediately
// and the pet just degrades to not accepting drops (logged, never fatal).
let dragWatcher = null;
let systemDragActive = false;
let dropCatcher = null;
let catcherHideTimer = null;

function createDropCatcher() {
  dropCatcher = new BrowserWindow({
    width: WIN,
    height: WIN,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    focusable: false,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-catcher.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 'floating' is the level empirically verified to receive drag events; the
  // catcher must NEVER call setIgnoreMouseEvents or it inherits the curse.
  dropCatcher.setAlwaysOnTop(true, 'floating');
  dropCatcher.loadFile(path.join(__dirname, 'renderer', 'catcher.html'));
  dropCatcher.on('closed', () => {
    dropCatcher = null;
  });
}

function setSystemDragActive(on) {
  if (on === systemDragActive) return;
  systemDragActive = on;
  // Tell the pet: while a drag is live it must keep ignoring mouse events so
  // macOS targets the catcher beneath it, and must not fight that state.
  if (win) {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.send('drag-mode', on);
  }
  if (!dropCatcher) return;
  clearTimeout(catcherHideTimer);
  if (on) {
    if (win) dropCatcher.setBounds(win.getBounds());
    dropCatcher.showInactive(); // never steal focus from the drag source
  } else {
    // Delay the hide: the watcher notices the button release within ~50ms,
    // which can be BEFORE the drop event reaches the catcher's renderer.
    catcherHideTimer = setTimeout(() => {
      if (dropCatcher) dropCatcher.hide();
      if (win) win.webContents.send('drop-hover', false);
    }, 350);
  }
}

// 拖拽依赖（python + pyobjc）缺失时只提醒一次，避免反复打扰。
let dragDepNotified = false;
function notifyDragDep() {
  if (isQuitting || dragDepNotified) return;
  dragDepNotified = true;
  if (Notification.isSupported()) {
    new Notification({
      title: '「拖文件起终端」未启用',
      body: '需要带 pyobjc 的 python3。装好（如 pip install pyobjc-framework-Quartz pyobjc-framework-Cocoa）后重启桌宠即可开启。',
    }).show();
  }
}

// 找一个装了 pyobjc 的 python 跑拖拽监听：macOS 自带的 /usr/bin/python3 常缺
// pyobjc（且编译困难），优先用 Homebrew 的（有预编译 wheel）。探测一次并缓存。
let cachedPython;
function findPython() {
  if (cachedPython !== undefined) return cachedPython;
  const candidates = [
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ];
  for (const cand of candidates) {
    try {
      execFileSync(
        cand,
        ['-c', 'import objc, Quartz; from AppKit import NSPasteboard'],
        { stdio: 'ignore', timeout: 5000 }
      );
      cachedPython = cand;
      return cand;
    } catch (_) {
      /* 这个 python 没 pyobjc / 不存在，试下一个 */
    }
  }
  cachedPython = null;
  return null;
}

function startDragWatcher() {
  const py = [
    'import time',
    'import Quartz',
    'from AppKit import NSPasteboard',
    "pb = NSPasteboard.pasteboardWithName_('Apple CFPasteboard drag')",
    'last = pb.changeCount()',
    'active = False',
    'while True:',
    '    btn = Quartz.CGEventSourceButtonState(Quartz.kCGEventSourceStateCombinedSessionState, 0)',
    '    cc = pb.changeCount()',
    '    if not active:',
    '        if btn and cc != last:',
    "            active = True",
    "            print('S', flush=True)",
    '        elif not btn:',
    '            last = cc',
    '    else:',
    '        if not btn:',
    '            active = False',
    '            last = pb.changeCount()',
    "            print('E', flush=True)",
    '    time.sleep(0.05)',
  ].join('\n');
  const python = findPython();
  if (!python) {
    console.log('[drag] no python with pyobjc — drops disabled');
    notifyDragDep();
    return;
  }
  try {
    dragWatcher = spawn(python, ['-u', '-c', py], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    console.log('[drag] watcher spawn failed: ' + err.message);
    return;
  }
  dragWatcher.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line === 'S') setSystemDragActive(true);
      else if (line === 'E') setSystemDragActive(false);
    }
  });
  dragWatcher.on('error', (err) => {
    console.log('[drag] watcher unavailable: ' + err.message);
    dragWatcher = null;
  });
  dragWatcher.on('exit', (code) => {
    console.log('[drag] watcher exited (' + code + ') — drops disabled');
    dragWatcher = null;
    setSystemDragActive(false);
    // 退出码 1 几乎都是缺 python3 的 pyobjc（import Quartz/AppKit 失败）：拖文件
    // 起终端整功能失效。首次发生弹一次通知引导安装，之后不再打扰。
    if (code === 1) notifyDragDep();
  });
  console.log('[drag] system-drag watcher started');
}

// Catcher → pet relays. Hover drives the 📂 cue; a dropped path triggers the
// eat animation + Terminal launch in the pet renderer (its existing flow).
ipcMain.on('catcher-hover', (_e, on) => {
  if (win) win.webContents.send('drop-hover', !!on);
});
ipcMain.on('catcher-drop', (_e, p) => {
  if (win && typeof p === 'string' && p) win.webContents.send('drop-path', p);
  if (dropCatcher) dropCatcher.hide();
});

// ---- Dev-only test bridge (PET_TEST_PORT) ------------------------------------
//
// A tiny loopback eval/capture server used by automated tests to drive the real
// windows (executeJavaScript) and verify pixels (capturePage). It never starts
// unless the PET_TEST_PORT env var is set, so normal runs carry no extra
// surface. POST JSON: {op:'eval'|'capture', target:'pet'|'chat', js?}.
function startTestBridge() {
  if (!process.env.PET_TEST_PORT) return;
  const os = require('os');
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { op, target, js } = JSON.parse(body || '{}');
        const w =
          target === 'chat' ? chatWin : target === 'catcher' ? dropCatcher : win;
        if (!w) throw new Error('window not ready');
        if (op === 'eval') {
          const result = await w.webContents.executeJavaScript(js, true);
          res.end(JSON.stringify({ ok: true, result }));
        } else if (op === 'capture') {
          const img = await w.webContents.capturePage();
          const file = path.join(os.tmpdir(), 'pet-cap-' + Date.now() + '.png');
          fs.writeFileSync(file, img.toPNG());
          res.end(JSON.stringify({ ok: true, file }));
        } else if (op === 'drag') {
          // Start a REAL native drag session carrying the file in `js`, so
          // drag-destination behavior can be tested without a human hand.
          const { nativeImage } = require('electron');
          const icon = nativeImage
            .createFromPath(
              path.join(CHARACTERS_DIR, currentCharacterId(), 'scratch', '01.png')
            )
            .resize({ width: 24 });
          w.webContents.startDrag({ file: js, icon });
          res.end(JSON.stringify({ ok: true }));
        } else if (op === 'mainEval') {
          // Evaluate in the MAIN process (window level, ignore state, …).
          // eslint-disable-next-line no-eval
          const result = await eval(js);
          res.end(JSON.stringify({ ok: true, result }));
        } else {
          throw new Error('unknown op');
        }
      } catch (err) {
        res.end(JSON.stringify({ ok: false, error: String(err && err.message) }));
      }
    });
  });
  srv.listen(Number(process.env.PET_TEST_PORT), '127.0.0.1', () => {
    console.log('[test] bridge on 127.0.0.1:' + process.env.PET_TEST_PORT);
  });
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
  // 首启 onboarding：还没填真 API Key 就在狗出场后稍等一会儿弹出设置面板，
  // 让朋友不用自己摸索右键就能直接配。1.2s 是给狗"出场感"留的余地，
  // 避免劈头盖脸把窗丢到脸上。
  if (!looksLikeRealKey(loadKimiConfig().apiKey)) {
    setTimeout(() => openSettings(), 1200);
  }
  // Bring up the Claude Code hook listener (best-effort; never blocks the pet).
  startClaudeServer();
  // Drop catcher + system-drag watcher: file drops onto the pet (section E).
  createDropCatcher();
  startDragWatcher();
  // Keep the catcher glued to the pet if it wanders mid-drag.
  win.on('move', () => {
    if (systemDragActive && dropCatcher && win) {
      dropCatcher.setBounds(win.getBounds());
    }
  });

  // Display sleep/wake & layout changes scramble the window's position (lock →
  // unlock is the usual culprit): tell the renderer to settle, then snap the
  // window back on-screen and resync. Reconcile twice — once now, once after a
  // beat — because display metrics can still be settling on the wake event.
  const calmThenReconcile = () => {
    if (win) win.webContents.send('power-sleep', false); // wake → resume motion
    reconcileWindow();
    setTimeout(reconcileWindow, 900);
  };
  powerMonitor.on('resume', calmThenReconcile);
  powerMonitor.on('unlock-screen', calmThenReconcile);
  powerMonitor.on('suspend', () => win && win.webContents.send('power-sleep', true));
  powerMonitor.on('lock-screen', () => win && win.webContents.send('power-sleep', true));
  // A monitor turning on/off, resolution change, or display add/remove.
  screen.on('display-metrics-changed', reconcileWindow);
  screen.on('display-added', reconcileWindow);
  screen.on('display-removed', reconcileWindow);

  // Dev-only eval/capture bridge; inert unless PET_TEST_PORT is set.
  startTestBridge();

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
  if (dragWatcher) dragWatcher.kill();
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
