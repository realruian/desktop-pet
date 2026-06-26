// pet.js — animation engine + behavior state machine for the hema.
//
// Responsibilities:
//   1. Preload all sprite frames, then drive a requestAnimationFrame render loop.
//   2. Bake the horizontal flip INTO the canvas (never via CSS) so the alpha
//      hit-test samples exactly the pixels the user sees.
//   3. Pixel-perfect click-through: toggle window mouse-ignore based on whether
//      the cursor is over an opaque body pixel.
//   4. Manual 1:1 dragging via Pointer Events (main process moves the window).
//   5. A phase-based behavior state machine: the pet RESTs ~half the time (eyes
//      tracking the cursor + subtle breathing), punctuated by short bursts of
//      activity (walk / scratch / wave / roll).

'use strict';

// ---- Constants --------------------------------------------------------------

const WIN = 160; // window + canvas size (square), matches main.js
const SRC = 420; // source frame size (px)
// The pet is drawn smaller than the window, anchored bottom-center — the spare
// headroom hosts the status chip, and the (transparent) window never shows.
const PET = 120; // drawn pet size (px)
const PET_X = (WIN - PET) / 2; // pet draw origin inside the canvas
const PET_Y = WIN - PET;
const WALK_SPEED = 130; // px/s while walking

// Autonomous wandering. true = the pet takes short strolls NEAR ITS HOME spot
// and always walks back home before resting again, so it never drifts across
// the screen. Strolls are strictly HORIZONTAL (the walk art is a side profile —
// diagonal/vertical sliding looks wrong), so the pet paces left/right along its
// home's level. Dragging it somewhere makes that spot the new home. false =
// strictly in-place activities only.
const WANDER = true;
const HOME_RANGE = 240; // max stroll distance from home (px, horizontal)
const STROLL_MIN = 60; // min stroll distance — keep walks visible
const HOME_EPS = 8; // "close enough to home" — skip the walk back
const ALPHA_THRESHOLD = 30; // alpha above this counts as "over the body"
const TAP_SLOP = 4; // px of movement below which a press counts as a tap
const RESUME_DELAY = 600; // ms to wait after a real drag before resting again
const DRAG_FLIP_EPS = 1.5; // 拖动时水平位移超过这个值才翻转朝向，防抖动来回翻

// Phase scheduler (v2): rest in meaningful stretches, then a short active burst.
const REST_MIN = 6000; // min REST phase duration (ms)
const REST_MAX = 12000; // max REST phase duration (ms)

// Bond / expression unlocks. Time only counts while the user is actively
// interacting with 河马 (hovering over the body or dragging it around).
const BOND_STORAGE_KEY = 'hema.bond.v1';
const BOND_SAVE_EVERY_MS = 3000;
const EXPRESSION_HOLD_LOOPS = 2;
const EXPRESSION_UNLOCKS = [
  { clip: 'tearful', label: '泪眼婆娑', thresholdMs: 60 * 1000 },
  { clip: 'tearful2', label: '委屈巴巴', thresholdMs: 3 * 60 * 1000 },
  { clip: 'tearful3', label: '想贴贴', thresholdMs: 5 * 60 * 1000 },
  { clip: 'tearful4', label: '舍不得你', thresholdMs: 8 * 60 * 1000 },
  { clip: 'cheer', label: '美滋滋', thresholdMs: 10 * 60 * 1000 },
];

// Breathing during REST: chest rises/falls, feet planted at the baseline.
const BREATH_AMT = 0.02; // ±2% vertical scale
const BREATH_PERIOD = 3200; // ms per breath cycle
const BASELINE = 388; // ground line in 420px source space (shared by all clips)

// REST idle: the pet holds a calm front-facing pose (the first 抱臂/scratch
// frame) under a gentle breathing scale. Identified by the REST sentinel clip
// name — it is NOT a real CLIPS entry, so the per-frame advance/draw paths skip
// it and render it through drawRest() instead.
const REST = 'rest';

// Claude Code status layer (section D). While any session is live the
// autonomous scheduler is paused and the pet holds an attentive REST (eyes
// still track the cursor), with a small status chip floating above its head.
//
// Status chip: one compact row above the pet's head — [tiny DRAWN indicator]
// [task label]. NO progress bar: Claude Code exposes no real percentage, so
// the chip only claims what it actually knows — running (blue spinner),
// needs you (amber pulse), finished (green check flash + a yip).
//
// Events arrive from EVERY Claude Code session on the machine (global hooks),
// so state is tracked PER SESSION and the chip shows the merged picture:
// any session waiting beats working; multiple running shows a ＋N suffix;
// each completion flashes done with that task's label (and a wave), then the
// chip returns to the remaining tasks or fades away.
// 气泡体量加大到接近 Codex：14px 主字、留白足。两行（项目名 + 状态词）用 H2，
// 单行（主动互动文案 / 解锁通知）用 H1。河马头顶约 y40，两行会轻微贴到额头，
// 尾巴正好落在头上。
const CHIP_H1 = 30; // 单行气泡高度
const CHIP_H2 = 38; // 两行气泡高度（项目名 + 状态词）——压两像素，离头远一点
const CHIP_TAIL = 4;// 气泡尾巴高度，尖端指向河马头（缩短，给头顶让出几像素）
const CHIP_Y = 0;   // 气泡顶部
const CHIP_PAD = 11; // 左右内边距
const CHIP_LABEL_FONT = '14px -apple-system, "PingFang SC", system-ui, sans-serif';
const CHIP_SUB_FONT = '11px -apple-system, "PingFang SC", system-ui, sans-serif';
// 主动互动单行文案用更小字号，让一句关心话在 160 窗口里完整显示不截断
// （也和大字号的 Claude 任务气泡形成主次）。
const CHIP_SPEECH_FONT = '11px -apple-system, "PingFang SC", system-ui, sans-serif';
const CHIP_FADE_MS = 450; // chip fade-out once everything is done
const DONE_FLASH_MS = 2200; // how long each task's done flash holds
const SESSION_STALE_MS = 15 * 60 * 1000; // forget sessions silent this long
const CHIP_COLOR = {
  working: '#7aa2ff', // calm blue — running
  waiting: '#ffcc66', // amber — needs you
  done: '#5fd07a', // green — finished
};

// Animation clips: frame count + playback fps. Art faces LEFT by default.
// (REST is not a clip — it holds scratch's first frame statically; see drawRest.)
const CLIPS = {
  walk: { fps: 10, frames: 8, faces: 'left' }, // side profile（河马向左走，向右自动翻转）
  scratch: { fps: 8, frames: 6, faces: 'front' }, // 河马：抱臂待机
  wave: { fps: 9, frames: 4, faces: 'front' }, // 河马：挥手打招呼
  roll: { fps: 8, frames: 6, faces: 'front' }, // 河马：微笑转头卖萌
  cheer: { fps: 8, frames: 5, faces: 'front' }, // 河马：捂嘴欢呼（当作开心接食）
  // 表情帧用相对「角色目录」的路径（loadAllFrames 会拼上 characters/<id>/）。
  tearful: {
    fps: 1,
    frames: ['expressions/tearful.png'],
    faces: 'front',
  },
  tearful2: {
    fps: 1,
    frames: ['expressions/tearful-2.png'],
    faces: 'front',
  },
  tearful3: {
    fps: 1,
    frames: ['expressions/tearful-3.png'],
    faces: 'front',
  },
  tearful4: {
    fps: 1,
    frames: ['expressions/tearful-4.png'],
    faces: 'front',
  },
};

// Weighted activity picks for an ACTIVE-phase burst. `walk` (the only activity
// that moves the window) is included only when WANDER is on; otherwise the pet
// stays put and an active burst is just an in-place animation.
const ACTIVITY_WEIGHTS = [
  ...(WANDER ? [{ name: 'walk', weight: 45 }] : []),
  { name: 'scratch', weight: 18 },
  { name: 'wave', weight: 18 },
  { name: 'roll', weight: 19 },
];
const EXPRESSION_WEIGHT = 10;

// ---- Canvas / context setup -------------------------------------------------

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

// Internal resolution = WIN × devicePixelRatio for crispness; we scale the
// drawing context so all draw coordinates stay in CSS/WIN space.
const dpr = window.devicePixelRatio || 1;
canvas.width = WIN * dpr;
canvas.height = WIN * dpr;
ctx.scale(dpr, dpr);
ctx.imageSmoothingEnabled = false;

// Baseline expressed in canvas draw coordinates (anchor for breathing), under
// the PET-sized, bottom-anchored placement.
const BASELINE_WIN = PET_Y + BASELINE * (PET / SRC);

// ---- Sprite preloading ------------------------------------------------------

// images[clip] = Image[] (index 0..frames-1). `let`, not `const`: switching
// characters loads the new set into a fresh object, then swaps it in atomically
// (no half-loaded frames ever render). 所有访问都走 `images` 变量名，重赋值即生效。
let images = {};
// 当前已加载的角色 id（启动时由 start() 设定；切换时由 switchCharacter 更新）。
let currentCharId = null;
// 当前角色显示名，给主动互动气泡文案里的 {name} 用；'桌宠' 只是首帧兜底。
let charName = '桌宠';

function loadOne(src, tasks) {
  const img = new Image();
  img.src = src;
  tasks.push(
    new Promise((resolve) => {
      // Resolve on both load and error so one bad file can't hang startup.
      img.onload = resolve;
      img.onerror = resolve;
    })
  );
  return img;
}

// Load every clip's frames for `charId` into `into` (defaults to the live
// `images`). Numbered clips → characters/<id>/<clip>/NN.png; array clips (the
// 表情) → characters/<id>/<相对路径>. Resolves once all frames settled.
function loadAllFrames(charId, into = images) {
  const tasks = [];
  const root = `../assets/characters/${charId}`;
  for (const clip of Object.keys(CLIPS)) {
    into[clip] = [];
    const frames = CLIPS[clip].frames;
    if (Array.isArray(frames)) {
      frames.forEach((src, i) => {
        into[clip][i] = loadOne(`${root}/${src}`, tasks);
      });
    } else {
      for (let i = 1; i <= frames; i++) {
        const name = String(i).padStart(2, '0') + '.png';
        into[clip][i - 1] = loadOne(`${root}/${clip}/${name}`, tasks);
      }
    }
  }
  return Promise.all(tasks);
}

// Hot-swap to another character: preload its full frame set into a fresh object
// FIRST, then swap `images` in one shot so no half-loaded frame ever renders.
// Resets to a clean REST so an in-flight walk/activity never strands the pet.
async function switchCharacter(charId) {
  if (!charId || charId === currentCharId) return;
  const next = {};
  await loadAllFrames(charId, next);
  images = next;
  currentCharId = charId;
  clearTimeout(state.phaseTimer);
  walkTarget = null;
  returningHome = false;
  state.frame = 0;
  // Claude 任务在跑时身体姿态另有逻辑接管（working→踏步 / waiting→抱臂），
  // 这里只在自由态回到 REST；持有态下次状态 tick 会自行纠正。
  if (!state.paused && !state.dragging && !claudeHolding()) {
    enterRest();
  } else {
    setClip(REST);
  }
}

// ---- Local state ------------------------------------------------------------

const state = {
  pos: { x: 0, y: 0 }, // window top-left in screen points
  home: null, // the spot the pet lives at (returns here after strolls)
  facingRight: false, // art faces left; flip when true
  paused: false, // menu toggle
  dragging: false,
  clipName: REST, // current clip; the REST sentinel marks the idle pose
  frame: 0, // current frame index within the clip
  loops: 0, // completed loops of the current clip
  loopTarget: 0, // loops to play before ending the activity (0 = open-ended)
  phaseTimer: null, // setTimeout id ending the current REST phase
  resumeTimer: null, // setTimeout id for post-drag resume
  activitiesLeft: 0, // activities remaining in the current ACTIVE phase
  bondMs: 0, // persisted interaction time used to unlock expressions
  unlockedExpressions: new Set(), // clip names from EXPRESSION_UNLOCKS
  lastBondSave: 0, // performance.now() of the last localStorage write
};

// Convenience: REST is the canonical idle, identified by the REST sentinel clip.
const isResting = () => state.clipName === REST;

// True while any live Claude session holds the pet (scheduler paused). The
// done-flash is transient and does NOT count as a hold.
const claudeHolding = () => claude.sessions.size > 0;

// Walk target (window top-left we're moving toward), null when not walking.
let walkTarget = null;

// True while the current walk is the "going home" leg (it ends the ACTIVE
// phase directly instead of counting as an activity).
let returningHome = false;

// True while the screen is locked/asleep: the wander scheduler stands down so
// the pet never roams against a stale work area (its position would otherwise
// be scrambled on wake). Main reconciles the real window position on wake.
let powerSleep = false;

// Latest global cursor position in SCREEN points, fed by pet.onCursor (~30 Hz)
// and refreshed inline by pointermove (which carries screen coords too). Drives
// BOTH the resting gaze and the click-through hit-test — the hit-test derives
// client coords by subtracting the window position rather than relying on
// mousemove events, because macOS stops delivering mousemove during a system
// drag session while the main process's cursor poll keeps flowing. That is what
// lets a dragged file un-ignore the window and land on the pet (section E).
// -1 means "no sample yet" → look straight ahead (East).
let latestCursor = { x: -1, y: -1 };

// Claude Code status (section D), tracked per session (global hooks mean any
// number of Claude Code tasks can be live at once across projects).
const claude = {
  sessions: new Map(), // session id -> { status:'working'|'waiting', label, last }
  display: 'idle', // derived: 'idle' | 'working' | 'waiting'
  taskLabel: '', // merged label shown while working/waiting
  taskExtra: 0, // how many MORE tasks are live beyond the labeled one (＋N)
  doneUntil: 0, // performance.now() end of the current done flash
  doneLabel: '', // label shown during the flash
  holding: false, // scheduler-hold transition tracking
  resumeTimer: null, // setTimeout id resuming the scheduler after the last task
  bodyDisplay: null, // 当前身体姿态对应的 display（'working'|'waiting'），避免重复切换
};

const unlockNotice = {
  until: 0,
  label: '',
};

// 主动互动（idle chatter）：河马时不时冒个 speech 气泡关心你。drawOverlay 里
// 以最低优先级显示，被任何 Claude / 解锁通知盖过。配置来自 config.json（idle 段）。
const speechBubble = { text: '', until: 0 };
const idleChatter = { enabled: true, minMinutes: 25, timer: null };
const SPEECH_HOLD_MS = 6000; // 气泡停留约 6 秒
const SPEECH_FADE_MS = 600; // 之后淡出

// True while a file/folder is being dragged over the pet (section E): show a
// folder glyph and a tiny scale-up cue inviting the drop.
let dropHover = false;

// True while ANY system file drag is in flight (fed by main's drag watcher).
// Main owns the ignore state for the whole drag — see onDragMode below.
let osDragActive = false;

// Whether the window is currently interactive (mouse-ignore OFF). Mirrors the
// main process so we only call setIgnore on actual changes (debounce).
let currentlyInteractive = false;

// Drag bookkeeping.
let downScreen = { x: 0, y: 0 }; // screen coords at pointerdown
let grab = { x: 0, y: 0 }; // cursor-to-window offset captured at pointerdown
let moved = false; // did the pointer move > TAP_SLOP during this press
let pendingMove = null; // throttled {x,y} window move, applied in the rAF loop

// ---- Helpers ----------------------------------------------------------------

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const finitePt = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

// Self-heal for corrupted coordinates (display changes / sleep-wake edges can
// leave a NaN in flight): forget any in-progress motion, resync the position
// from the real window, and settle back into REST. Main independently drops
// non-finite move-to frames, so the pet can stutter but never crash.
async function recoverPosition(reason) {
  console.warn('[pet] non-finite position (' + reason + '); resyncing');
  walkTarget = null;
  returningHome = false;
  pendingMove = null;
  try {
    const [wx, wy] = await window.pet.getPos();
    state.pos = { x: wx, y: wy };
    if (!finitePt(state.home)) state.home = { x: wx, y: wy };
  } catch (_) {
    /* keep the last sane values; the next frame retries nothing */
  }
  if (!state.paused && !state.dragging) enterRest();
}
const frameCount = (clip) =>
  Array.isArray(CLIPS[clip].frames)
    ? CLIPS[clip].frames.length
    : CLIPS[clip].frames;

function unlockedExpressionWeights() {
  return EXPRESSION_UNLOCKS.filter((e) =>
    state.unlockedExpressions.has(e.clip)
  ).map((e) => ({ name: e.clip, weight: EXPRESSION_WEIGHT }));
}

function pickActivity() {
  const weights = [...ACTIVITY_WEIGHTS, ...unlockedExpressionWeights()];
  const total = weights.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total;
  for (const b of weights) {
    if ((r -= b.weight) < 0) return b.name;
  }
  return 'scratch';
}

function loadBondState() {
  try {
    const raw = localStorage.getItem(BOND_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.bondMs = Math.max(0, Number(saved.bondMs) || 0);
    const unlocked = Array.isArray(saved.unlocked) ? saved.unlocked : [];
    state.unlockedExpressions = new Set(
      unlocked.filter((clip) => EXPRESSION_UNLOCKS.some((e) => e.clip === clip))
    );
    // If thresholds were lowered in an update, honor the already-earned time.
    for (const e of EXPRESSION_UNLOCKS) {
      if (state.bondMs >= e.thresholdMs) state.unlockedExpressions.add(e.clip);
    }
  } catch (_) {
    state.bondMs = 0;
    state.unlockedExpressions = new Set();
  }
}

function saveBondState(now = performance.now(), force = false) {
  if (!force && now - state.lastBondSave < BOND_SAVE_EVERY_MS) return;
  state.lastBondSave = now;
  try {
    localStorage.setItem(
      BOND_STORAGE_KEY,
      JSON.stringify({
        bondMs: Math.floor(state.bondMs),
        unlocked: [...state.unlockedExpressions],
      })
    );
  } catch (_) {
    /* storage can fail in odd embed modes; unlocks still work for this run */
  }
}

function playExpression(clip) {
  clearTimeout(state.phaseTimer);
  walkTarget = null;
  returningHome = false;
  state.activitiesLeft = 1;
  setClip(clip, { loopTarget: EXPRESSION_HOLD_LOOPS });
}

function unlockExpression(e, now) {
  state.unlockedExpressions.add(e.clip);
  saveBondState(now, true);
  unlockNotice.label = '解锁：' + e.label;
  unlockNotice.until = now + DONE_FLASH_MS;
  if (!state.paused && !state.dragging && !claudeHolding()) {
    playExpression(e.clip);
  }
}

function cursorOverDog() {
  if (latestCursor.x < 0) return false;
  return isOverBody(
    latestCursor.x - state.pos.x,
    latestCursor.y - state.pos.y
  );
}

function tickBond(dt, now) {
  if (!(state.dragging || cursorOverDog())) return;
  state.bondMs += dt * 1000;
  for (const e of EXPRESSION_UNLOCKS) {
    if (
      state.bondMs >= e.thresholdMs &&
      !state.unlockedExpressions.has(e.clip)
    ) {
      unlockExpression(e, now);
      break;
    }
  }
  saveBondState(now);
}

// ---- Pixel-perfect hit test -------------------------------------------------

// Map client (CSS) coords to canvas internal pixels (accounting for rect scale
// and DPR), then sample the alpha channel of the currently-rendered frame.
// Because the flip AND the breathing scale are baked into the canvas (we sample
// AFTER drawing), the sampled pixels always match exactly what's on screen.
function isOverBody(cx, cy) {
  const rect = canvas.getBoundingClientRect();
  if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) {
    return false;
  }
  const px = Math.floor(((cx - rect.left) / rect.width) * canvas.width);
  const py = Math.floor(((cy - rect.top) / rect.height) * canvas.height);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return false;
  const alpha = ctx.getImageData(px, py, 1, 1).data[3];
  return alpha > ALPHA_THRESHOLD;
}

// Re-evaluate click-through against the latest global cursor sample. Called on
// every cursor poll tick, on pointermove, and every render frame (the pet can
// move/breathe under a still cursor). Client coords are derived from the SCREEN
// cursor minus the window position so the test keeps updating during system
// drags, when no mouse events reach the window at all.
function updateInteractivity() {
  if (state.dragging) return; // never toggle ignore mid-drag
  if (osDragActive) return; // main owns the ignore state during system drags
  if (latestCursor.x < 0) return; // no cursor sample yet
  const over = cursorOverDog();
  if (over !== currentlyInteractive) {
    currentlyInteractive = over;
    window.pet.setIgnore(!over); // interactive = NOT ignoring mouse
  }
}

// ---- Rendering --------------------------------------------------------------

// Draw a single clip frame, baking the facing flip into the canvas.
function drawClipFrame() {
  const img = images[state.clipName][state.frame];
  if (!img || !img.complete || img.naturalWidth === 0) return;
  const clip = CLIPS[state.clipName] || {};
  const src = clip.src || SRC;
  ctx.save();
  if (state.facingRight) {
    // Bake the horizontal flip into the canvas so the hit-test stays accurate.
    ctx.translate(WIN, 0);
    ctx.scale(-1, 1);
  }
  // Uniform anchoring: every clip shares the 420px baseline, so a straight
  // 420→PET scale keeps the pet grounded with no vertical "jump" between poses.
  ctx.drawImage(img, 0, 0, src, src, PET_X, PET_Y, PET, PET);
  ctx.restore();
}

// Draw the REST pose: the calm front-facing 抱臂 frame held static under a
// gentle breathing scale (feet planted at the baseline, chest rises/falls).
function drawRest(now) {
  const img = images.scratch && images.scratch[0];
  if (!img || !img.complete || img.naturalWidth === 0) return;

  // Breathing scale, anchored at the ground baseline (feet planted, chest rises).
  const s = 1 + BREATH_AMT * Math.sin((2 * Math.PI * now) / BREATH_PERIOD);
  const cx = WIN / 2;

  ctx.save();
  ctx.translate(cx, BASELINE_WIN);
  ctx.scale(1, s);
  ctx.translate(-cx, -BASELINE_WIN);
  ctx.drawImage(img, 0, 0, SRC, SRC, PET_X, PET_Y, PET, PET);
  ctx.restore();
}

function drawFrame(now) {
  ctx.clearRect(0, 0, WIN, WIN);

  // Drop-hover gives a tiny scale-up cue (section E), anchored at the ground
  // baseline so the feet stay planted. Baked into the canvas, so the hit-test
  // (which samples after drawing) stays pixel-accurate against the larger pet.
  const cueScale = dropHover ? 1.06 : 1;
  const scaled = cueScale !== 1;
  if (scaled) {
    const cx = WIN / 2;
    ctx.save();
    ctx.translate(cx, BASELINE_WIN);
    ctx.scale(cueScale, cueScale);
    ctx.translate(-cx, -BASELINE_WIN);
  }

  if (isResting()) {
    drawRest(now);
  } else {
    drawClipFrame();
  }

  if (scaled) ctx.restore();
}

// Truncate `text` to fit `maxW` px in the current ctx font, with an ellipsis.
function ellipsize(text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 1 && ctx.measureText(text + '…').width > maxW) {
    text = text.slice(0, -1);
  }
  return text + '…';
}

// 小爱心（speech 模式的指示器）：粉色实心，画在气泡左侧代替转圈/对勾。
function drawHeart(cx, cy, s, color) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.85);
  ctx.bezierCurveTo(cx + s * 1.1, cy + s * 0.1, cx + s * 0.6, cy - s * 0.95, cx, cy - s * 0.3);
  ctx.bezierCurveTo(cx - s * 0.6, cy - s * 0.95, cx - s * 1.1, cy + s * 0.1, cx, cy + s * 0.85);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// 河马头顶的对话气泡——白色圆角卡片 + 向下尾巴。两种形态：
//   · 有项目名（Claude 任务）→ 两行：项目名（上、主、深色 14px）+ 状态词（下、辅、
//     浅灰 11px，如「进行中 / 等你确认 / 完成」），指示器在左侧垂直居中。
//   · 无项目名（主动互动文案 / 解锁通知）→ 单行：指示器 + 文案。
// 宽度随内容自适应（取两行较宽者），整体居中于河马头顶。
const CHIP_GAP = 8; // 指示器与文字间距
const CHIP_IND_R = 5.5; // 指示器（含转圈底环）半径
function drawStatusChip(now, alpha, mode, project, status, suffix) {
  const color = CHIP_COLOR[mode] || CHIP_COLOR.working;
  const twoLine = !!project; // 有项目名 → 两行
  const H = twoLine ? CHIP_H2 : CHIP_H1;
  const by = CHIP_Y + 1;
  const r = Math.min(14, H / 2); // 适中圆角（不是全胶囊），更像 Codex 卡片
  const cx = WIN / 2; // 水平中心（尾巴对准河马头）
  const MAX_W = WIN - 12; // 气泡最大宽（受 160 窗口限制）
  // 指示器钉在左上角、与气泡左上圆角同心（上边距=左边距=r-CHIP_IND_R）；
  // 文字从指示器右侧 CHIP_GAP 处起。
  const indBlock = r + CHIP_IND_R + CHIP_GAP;

  ctx.save();
  ctx.textAlign = 'left';

  // 量宽：项目名（14px）与状态/单行文字分别量，取较宽者。
  ctx.font = CHIP_LABEL_FONT;
  const sufW = suffix ? ctx.measureText(suffix).width + 4 : 0;
  const line1 = twoLine
    ? ellipsize(project, MAX_W - indBlock - CHIP_PAD - sufW)
    : '';
  const line1W = twoLine ? ctx.measureText(line1).width : 0;
  ctx.font = twoLine ? CHIP_SUB_FONT : CHIP_SPEECH_FONT;
  const line2 = ellipsize(status || 'Claude', MAX_W - indBlock - CHIP_PAD);
  const line2W = ctx.measureText(line2).width;

  const textW = Math.max(line1W + sufW, line2W);
  const chipW = Math.min(MAX_W, indBlock + textW + CHIP_PAD);
  const bx = (WIN - chipW) / 2;

  ctx.globalAlpha = alpha;

  // 气泡主体 + 尾巴：一条连续路径，一次 fill + 一次 stroke 完成。这样尾巴是外轮廓
  // 的一部分（有描边、和主体无缝），底边不会被主体描边横切一条线——白底上也能
  // 看见尾巴。底边在尾巴左右根处断开插入三角，其余按圆角矩形走。
  // 半像素偏移让 1px 描边落在像素网格上更清晰。
  const L = bx + 0.5;
  const T = by + 0.5;
  const R = bx + chipW - 0.5;
  const B = by + H - 0.5;
  ctx.beginPath();
  ctx.moveTo(L + r, T);
  ctx.lineTo(R - r, T);
  ctx.arcTo(R, T, R, T + r, r); // 右上圆角
  ctx.lineTo(R, B - r);
  ctx.arcTo(R, B, R - r, B, r); // 右下圆角
  ctx.lineTo(cx + 5, B); // 底边右段 → 尾巴右根
  ctx.lineTo(cx, by + H + CHIP_TAIL); // 尾巴尖
  ctx.lineTo(cx - 5, B); // 尾巴左根 → 底边左段
  ctx.lineTo(L + r, B);
  ctx.arcTo(L, B, L, B - r, r); // 左下圆角
  ctx.lineTo(L, T + r);
  ctx.arcTo(L, T, L + r, T, r); // 左上圆角
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.98)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 状态指示器：钉在左上角，与气泡左上圆角同心。
  const ix = bx + r;
  const iy = by + r;

  if (mode === 'working') {
    // 同心 loading 环：浅色底环（轨道）+ 彩色转动弧，约 0.8 圈/秒
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(ix, iy, CHIP_IND_R, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.stroke();
    const a0 = (now / 1250) * 2 * Math.PI;
    ctx.beginPath();
    ctx.arc(ix, iy, CHIP_IND_R, a0, a0 + Math.PI * 1.4);
    ctx.strokeStyle = color;
    ctx.stroke();
  } else if (mode === 'waiting') {
    // 琥珀色脉冲点：需要你来确认
    const pulse = 0.6 + 0.4 * Math.sin(now / 280);
    ctx.beginPath();
    ctx.arc(ix, iy, 4.5, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha * pulse;
    ctx.fill();
    ctx.globalAlpha = alpha;
  } else if (mode === 'speech') {
    // 主动互动：粉色小爱心，随呼吸轻微缩放
    const beat = 1 + 0.12 * Math.sin(now / 320);
    drawHeart(ix, iy, 4.6 * beat, '#ff6b9d');
  } else {
    // 完成：绿色圆 + 白色对勾
    ctx.beginPath();
    ctx.arc(ix, iy, 4.8, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ix - 2.2, iy + 0.2);
    ctx.lineTo(ix - 0.5, iy + 2.0);
    ctx.lineTo(ix + 2.5, iy - 1.9);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  const tx = bx + indBlock;
  if (twoLine) {
    // 两行：项目名（主，深色）+ 状态词（辅，浅灰）
    ctx.textBaseline = 'alphabetic';
    ctx.font = CHIP_LABEL_FONT;
    ctx.fillStyle = 'rgba(20,20,30,0.88)';
    ctx.fillText(line1, tx, by + 16);
    if (suffix) {
      ctx.fillStyle = 'rgba(20,20,30,0.4)';
      ctx.fillText(suffix, tx + line1W + 4, by + 16);
    }
    ctx.font = CHIP_SUB_FONT;
    ctx.fillStyle = 'rgba(20,20,30,0.5)';
    ctx.fillText(line2, tx, by + 30);
  } else {
    // 单行：指示器 + 文案，垂直居中
    ctx.textBaseline = 'middle';
    ctx.font = CHIP_SPEECH_FONT;
    ctx.fillStyle = 'rgba(20,20,30,0.85)';
    ctx.fillText(line2, tx, iy + 0.5);
  }

  ctx.restore();
}

// Draw the status chip / drop cue as an OVERLAY, after the click-through
// hit-test has already sampled the (chip-free) pet. Keeping the overlay out of
// the hit-test means it never becomes draggable nor disturbs click-through.
function drawOverlay(now) {
  // Chip visibility: a fresh completion flashes done (+ its task label) for
  // DONE_FLASH_MS and takes precedence; otherwise working/waiting persist;
  // after the last task the flash fades the chip away; idle → nothing.
  // Claude 任务气泡两行：project（项目名，常驻）+ status（状态词）。
  // 单行场景（解锁通知 / 主动互动）只用 status，project 留空。
  let chipAlpha = 0;
  let mode = null;
  let project = '';
  let status = '';
  let suffix = '';
  if (now < unlockNotice.until) {
    mode = 'done';
    status = unlockNotice.label;
    chipAlpha = 1;
  } else if (now < unlockNotice.until + CHIP_FADE_MS) {
    mode = 'done';
    status = unlockNotice.label;
    chipAlpha = 1 - (now - unlockNotice.until) / CHIP_FADE_MS;
  } else if (now < claude.doneUntil) {
    mode = 'done';
    project = claude.doneLabel || 'Claude';
    status = '完成';
    chipAlpha = 1;
  } else if (claude.display === 'working' || claude.display === 'waiting') {
    mode = claude.display;
    project = claude.taskLabel || 'Claude';
    status = mode === 'waiting' ? '等你确认' : '进行中';
    if (claude.taskExtra > 0) suffix = '＋' + claude.taskExtra;
    chipAlpha = 1;
  } else if (now < claude.doneUntil + CHIP_FADE_MS) {
    mode = 'done';
    project = claude.doneLabel || 'Claude';
    status = '完成';
    chipAlpha = 1 - (now - claude.doneUntil) / CHIP_FADE_MS;
  }
  // 主动互动气泡：最低优先级——只有在没有任何 Claude/解锁状态时才冒出来。
  if (!mode && now < speechBubble.until) {
    mode = 'speech';
    status = speechBubble.text;
    chipAlpha = 1;
  } else if (!mode && now < speechBubble.until + SPEECH_FADE_MS) {
    mode = 'speech';
    status = speechBubble.text;
    chipAlpha = 1 - (now - speechBubble.until) / SPEECH_FADE_MS;
  }
  if (chipAlpha > 0.01 && mode)
    drawStatusChip(now, chipAlpha, mode, project, status, suffix);

  // Drop-hover cue: a folder glyph centered over the pet inviting the drop (E).
  if (dropHover) {
    drawGlyph('folder', WIN / 2, PET_Y + PET / 2, 34, 1);
  }

  // Eat animation: the dropped item's glyph accelerates into the mouth,
  // shrinking and fading as it goes (the chomp clip plays underneath).
  if (eat.active) {
    const t = (now - eat.t0) / EAT_FLY_MS;
    if (t >= 1) {
      eat.active = false;
    } else {
      const k = t * t; // ease-in: the pet sucks it in
      const mx = WIN / 2; // mouth, roughly mid-face on the front-facing clip
      const my = PET_Y + PET * 0.5;
      const gsize = Math.max(6, 32 * (1 - 0.85 * k));
      drawGlyph(
        eat.glyph,
        eat.from.x + (mx - eat.from.x) * k,
        eat.from.y + (my - eat.from.y) * k,
        gsize,
        1 - 0.3 * t
      );
    }
  }
}

let lastTime = performance.now();

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1); // seconds, clamped
  lastTime = now;

  // 1) Apply any throttled drag move (1:1 with the cursor).
  if (pendingMove) {
    if (finitePt(pendingMove)) {
      window.pet.moveTo(pendingMove.x, pendingMove.y);
      state.pos.x = pendingMove.x;
      state.pos.y = pendingMove.y;
      pendingMove = null;
    } else {
      recoverPosition('drag move');
    }
  }

  // 2) Advance the current clip by elapsed time vs its fps (REST holds a static
  //    pose, so it is skipped here and handled entirely in drawFrame/drawRest).
  if (!isResting()) advanceAnimation(dt);

  // 3) Move toward the walk target if we're walking.
  if (walkTarget) stepWalk(dt);

  // 4) Draw, then re-test click-through against the (possibly moved) sprite.
  drawFrame(now);
  updateInteractivity();
  // 5) Count active interaction toward expression unlocks.
  tickBond(dt, now);
  // 6) Chip overlay last, so it never participates in the hit-test above.
  drawOverlay(now);

  requestAnimationFrame(loop);
}

function advanceAnimation(dt) {
  const clip = CLIPS[state.clipName];
  state._frameAcc = (state._frameAcc || 0) + dt;
  const frameDur = 1 / clip.fps;
  while (state._frameAcc >= frameDur) {
    state._frameAcc -= frameDur;
    state.frame++;
    if (state.frame >= frameCount(state.clipName)) {
      state.frame = 0;
      state.loops++;
      // In-place clips (scratch/wave/roll) end the activity once they've played
      // the requested loops. Walk that is actually moving is driven by arrival at
      // its target instead, so it ignores loopTarget. But a walk with NO walkTarget
      // is the Claude「工作中」原地踏步——它照常按 loopTarget 收尾。
      if (
        state.loopTarget > 0 &&
        (state.clipName !== 'walk' || !walkTarget)
      ) {
        if (state.loops >= state.loopTarget) {
          onActivityDone();
          return;
        }
      }
    }
  }
}

function stepWalk(dt) {
  const to = walkTarget;
  if (!finitePt(state.pos) || !finitePt(to)) {
    recoverPosition('walk step');
    return;
  }
  const d = dist(state.pos, to);
  if (d <= 3) {
    // Snap to target and end this activity.
    state.pos.x = to.x;
    state.pos.y = to.y;
    window.pet.moveTo(to.x, to.y);
    walkTarget = null;
    onActivityDone();
    return;
  }
  const step = WALK_SPEED * dt;
  const nx = state.pos.x + ((to.x - state.pos.x) / d) * step;
  const ny = state.pos.y + ((to.y - state.pos.y) / d) * step;
  state.pos.x = nx;
  state.pos.y = ny;
  window.pet.moveTo(nx, ny);
}

// ---- Behavior state machine (phase scheduler) -------------------------------
//
// Lifecycle: REST phase (rand REST_MIN..REST_MAX) → ACTIVE phase (1–2 weighted
// activities back-to-back) → REST phase → … The pet therefore rests ~half its
// time, in meaningful stretches rather than constant motion.

function setClip(name, { loopTarget = 0 } = {}) {
  state.clipName = name;
  state.frame = 0;
  state.loops = 0;
  state.loopTarget = loopTarget;
  state._frameAcc = 0;
}

// Enter (or re-enter) the REST phase: the canonical idle. Holds the static 抱臂
// pose + breathing, then schedules the next ACTIVE phase. Replaces v1's goIdle.
function enterRest() {
  walkTarget = null;
  returningHome = false;
  setClip(REST);
  scheduleActive();
}

function scheduleActive() {
  clearTimeout(state.phaseTimer);
  // Don't arm the scheduler while live Claude sessions own the pet (the
  // resume after the last task is driven by refreshClaude's resume timer).
  if (state.paused || powerSleep || state.dragging || claudeHolding()) return;
  const delay = rand(REST_MIN, REST_MAX);
  state.phaseTimer = setTimeout(enterActive, delay);
}

// Begin an ACTIVE phase: run n=1 (60%) or 2 (40%) activities back-to-back.
function enterActive() {
  if (state.paused || powerSleep || state.dragging || claudeHolding()) return;
  state.activitiesLeft = Math.random() < 0.4 ? 2 : 1;
  runNextActivity();
}

// Start the next activity in the current ACTIVE phase.
function runNextActivity() {
  if (state.paused || powerSleep || state.dragging || claudeHolding()) return;
  const choice = pickActivity();
  if (choice === 'walk') {
    startWalk();
  } else {
    // In-place clips: play briefly, then onActivityDone.
    const isExpression = EXPRESSION_UNLOCKS.some((e) => e.clip === choice);
    setClip(choice, {
      loopTarget: isExpression
        ? EXPRESSION_HOLD_LOOPS
        : Math.random() < 0.5
          ? 1
          : 2,
    });
  }
}

// One activity finished: run the next one, or wrap up the burst — walking back
// home first if the strolls left the pet away from its spot, then REST.
function onActivityDone() {
  if (state.paused || state.dragging) return;
  if (claudeHolding()) {
    // A one-off (e.g. the completion yip) finished during a hold: settle back
    // into the attentive REST instead of looping the clip.
    setClip(REST);
    return;
  }
  if (returningHome) {
    // The going-home leg just arrived: settle straight into REST.
    returningHome = false;
    enterRest();
    return;
  }
  state.activitiesLeft -= 1;
  if (state.activitiesLeft > 0) {
    runNextActivity();
  } else if (state.home && dist(state.pos, state.home) > HOME_EPS) {
    returnHome();
  } else {
    enterRest();
  }
}

// Walk back to the home spot (the burst's closing leg).
function returnHome() {
  returningHome = true;
  state.facingRight = state.home.x > state.pos.x;
  walkTarget = { x: state.home.x, y: state.home.y };
  setClip('walk'); // looped; arrival at home ends it via onActivityDone
}

function startWalk() {
  // Re-query the work area each walk so display/resolution changes are honored.
  // getWorkArea is async; nothing else should drive the pet while we await it.
  window.pet.getWorkArea().then((wa) => {
    if (state.paused || powerSleep || state.dragging || claudeHolding()) return;

    // Bounds for the window top-left so the whole window stays on-screen.
    const minX = wa.x;
    const maxX = wa.x + wa.width - WIN;
    const minY = wa.y;
    const maxY = wa.y + wa.height - WIN;

    // Stroll target: HORIZONTAL only, anchored on HOME (not the current
    // position, so consecutive walks can never drift the pet away). Pick the
    // side with room: near a screen edge, walk toward the open side.
    const home = state.home || state.pos;
    const reach = (d) => (d === 1 ? maxX - home.x : home.x - minX);
    let dir = Math.random() < 0.5 ? -1 : 1;
    if (reach(dir) < STROLL_MIN && reach(-dir) > reach(dir)) dir = -dir;
    const span = Math.min(HOME_RANGE, Math.max(reach(dir), 0));
    const tx = home.x + dir * rand(Math.min(STROLL_MIN, span), span);
    const ty = clamp(home.y, minY, maxY); // stay on home's level

    if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
      recoverPosition('stroll target');
      return;
    }
    state.facingRight = tx > state.pos.x;
    walkTarget = { x: tx, y: ty };
    setClip('walk'); // looped; arrival at target ends it
  });
}

// ---- Pointer / drag handling ------------------------------------------------

canvas.addEventListener('pointermove', (e) => {
  // These arrive even while the window ignores mouse events (forward:true).
  // Refresh the shared screen-coord sample; isOverBody() maps it to canvas
  // pixels inside updateInteractivity().
  latestCursor = { x: e.screenX, y: e.screenY };

  if (state.dragging) {
    // Track whether this gesture has exceeded the tap slop.
    const wasMoved = moved;
    moved =
      moved ||
      dist(downScreen, { x: e.screenX, y: e.screenY }) > TAP_SLOP;
    if (moved) {
      // 确认是拖动（而非 tap）：第一次跨过阈值时切到「跑」姿态（running-left/right）。
      // 只在上升沿 setClip 一次，否则每帧重置 frame 会让动画卡在第 0 帧。
      // walkTarget 为 null + loopTarget=0 → 开放循环，拖多久跑多久。
      if (!wasMoved) setClip('walk');
      // 按水平移动方向更新朝向（小阈值防抖动来回翻）；纯垂直/微动保持上一次朝向。
      if (e.movementX > DRAG_FLIP_EPS) state.facingRight = true;
      else if (e.movementX < -DRAG_FLIP_EPS) state.facingRight = false;
    }
    // Throttle the actual window move to the rAF loop for 1:1, jank-free drag.
    pendingMove = { x: e.screenX - grab.x, y: e.screenY - grab.y };
    return;
  }

  // Not dragging: keep click-through in sync immediately on hover changes.
  updateInteractivity();
});

canvas.addEventListener('pointerdown', (e) => {
  // Only the left button initiates a drag/tap; ignore otherwise.
  if (e.button !== 0) return;
  if (!isOverBody(e.clientX, e.clientY)) return;

  canvas.setPointerCapture(e.pointerId);
  state.dragging = true;
  moved = false;
  downScreen = { x: e.screenX, y: e.screenY };

  // Pause the scheduler while held and keep the window interactive.
  clearTimeout(state.phaseTimer);
  clearTimeout(state.resumeTimer);
  walkTarget = null;
  returningHome = false;
  currentlyInteractive = true;
  window.pet.setIgnore(false);

  // Grab offset = cursor minus current window top-left, so the pet stays put
  // relative to the cursor for the duration of the drag. We read it
  // synchronously from our locally-tracked position (the window is only ever
  // moved by our own moveTo, so state.pos is authoritative) — avoiding an async
  // getPos() round-trip that a fast first pointermove could otherwise beat,
  // which would jump the window for one frame.
  grab = { x: e.screenX - state.pos.x, y: e.screenY - state.pos.y };
});

async function endDrag(e) {
  if (!state.dragging) return;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch (_) {
    /* capture may already be gone */
  }
  state.dragging = false;
  pendingMove = null;

  // Resync local position from the source of truth (the window itself).
  const [wx, wy] = await window.pet.getPos();
  state.pos = { x: wx, y: wy };

  if (state.paused) {
    // Paused: settle straight into REST, no scheduling.
    setClip(REST);
    return;
  }

  // Live Claude sessions were held off while the user dragged (drag always
  // wins). 落地后按当前合并状态恢复对应姿态（working→踏步，waiting→抱臂），
  // 而不是停在 eyes，免得身体和头顶芯片对不上。调度器仍保持暂停。
  if (claudeHolding()) {
    claude.bodyDisplay = claude.display;
    applyClaudeBody(claude.display);
    return;
  }

  if (!moved) {
    // A tap (petting): the pet yips once as a one-off activity, then REST.
    state.activitiesLeft = 1;
    setClip('wave', { loopTarget: 1 });
  } else {
    // A real drag: wherever you put the pet down is its new home. Settle, then
    // resume the rest/active cycle after a short beat.
    state.home = { x: wx, y: wy };
    setClip(REST);
    state.resumeTimer = setTimeout(() => {
      enterRest();
    }, RESUME_DELAY);
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// Right-click anywhere on the body → main-process context menu.
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.showMenu();
});

// Double-click on the body → open the chat panel (section F). The first click
// of the pair still pets the pet (a yip), which makes a nice greeting.
canvas.addEventListener('dblclick', (e) => {
  if (!isOverBody(e.clientX, e.clientY)) return;
  window.pet.openChat();
});

// ---- File / folder drop → Terminal + Claude Code (section E) -----------------
//
// Globally swallow drags so the window never navigates to a dropped file. On
// the canvas we light up a folder cue and, on drop, resolve the dropped path and ask
// main to open Terminal there running `claude`. Dropping onto the opaque body
// works because hovering the body has already turned click-through off.
for (const evt of ['dragover', 'drop']) {
  window.addEventListener(
    evt,
    (e) => {
      e.preventDefault();
    },
    false
  );
}

canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  dropHover = true; // draw the folder glyph + scale-up cue
});

canvas.addEventListener('dragleave', () => {
  dropHover = false;
});

canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  dropHover = false;
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  const p = window.pet.getPathForFile(f);
  if (p) eatAndOpen(p, { x: e.clientX, y: e.clientY });
});

// 在 canvas 上画一个线性图标（folder/file），替代原先的 emoji glyph，跟
// 窗口里的 IconPark 线条语言统一。双描边（白底+深线）保证它在浅色桌宠身上
// 任何部位都看得清。kind: 'folder' | 'file'，path 用 48 单位 viewBox。
function drawGlyph(kind, cx, cy, size, alpha) {
  const s = size / 48;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const paths =
    kind === 'file'
      ? [new Path2D('M14 6H30L38 16V42H14V6Z'), new Path2D('M30 6V16H38')]
      : [new Path2D('M5 8H22L26 14H43V40H5V8Z')];
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 7;
  paths.forEach((p) => ctx.stroke(p));
  ctx.strokeStyle = 'rgba(38,40,52,0.95)';
  ctx.lineWidth = 3.5;
  paths.forEach((p) => ctx.stroke(p));
  ctx.restore();
}

// ---- "Eat" the drop ----------------------------------------------------------
//
// Feedback for a successful drop: the item's glyph flies from the drop point
// into the pet's mouth while the wave clip plays as a chomp, then the normal
// wrap-up (walk home / rest / attentive eyes) takes over via onActivityDone.
// The Terminal launch fires immediately — it spins up behind the animation.
const EAT_FLY_MS = 460; // glyph flight time, drop point → mouth
const eat = { active: false, t0: 0, from: null, glyph: 'folder' };

function eatAndOpen(p, from) {
  window.pet.openInClaude(p);

  // Folder vs file only picks the glyph; a dot-extension on the last path
  // segment is a good-enough tell without a round-trip to main.
  const base = p.split('/').pop() || '';
  eat.glyph = /\.[^.]+$/.test(base) ? 'file' : 'folder';
  eat.active = true;
  eat.t0 = performance.now();
  eat.from =
    from && from.x != null
      ? { x: from.x, y: from.y }
      : { x: WIN / 2, y: PET_Y - 4 };

  // Chomp (same one-off shape as the tap yip, two loops for a real swallow).
  if (state.paused || state.dragging) return; // glyph only; don't fight a pause
  clearTimeout(state.phaseTimer);
  walkTarget = null;
  returningHome = false;
  state.activitiesLeft = 1;
  setClip('wave', { loopTarget: 2 });
}

// 「演示动作」：把每个动作依次播一遍，方便一次看全（日常是随机触发、要干等）。
// 用定时器轮播，播完回到正常的休息/活动循环。
let demoTimer = null;
function runDemo() {
  if (state.paused || demoTimer) return;
  clearTimeout(state.phaseTimer);
  clearTimeout(state.resumeTimer);
  walkTarget = null;
  returningHome = false;
  const seq = ['walk', 'scratch', 'wave', 'roll', 'cheer'];
  let i = 0;
  const next = () => {
    if (i >= seq.length) {
      demoTimer = null;
      enterRest();
      return;
    }
    setClip(seq[i++]);
    demoTimer = setTimeout(next, 1800);
  };
  next();
}

// ---- Menu commands from main ------------------------------------------------

window.pet.onMenuCommand((cmd) => {
  if (cmd === 'toggle-pause') {
    state.paused = !state.paused;
    if (state.paused) {
      // Force REST and stop the scheduler until resumed.
      clearTimeout(state.phaseTimer);
      clearTimeout(state.resumeTimer);
      clearTimeout(demoTimer);
      demoTimer = null;
      walkTarget = null;
      returningHome = false;
      setClip(REST);
    } else {
      enterRest();
    }
  } else if (cmd === 'demo') {
    runDemo();
  }
});

// Global cursor feed (screen points) → aim the resting gaze AND re-test
// click-through right away (the pet may move/breathe under a still cursor).
window.pet.onCursor((p) => {
  latestCursor = { x: p.x, y: p.y };
  updateInteractivity();
});

// System-drag mode (section E): while any file drag is in flight, an
// invisible catcher window is shown at the pet's bounds to receive the drop
// (this window can't — macOS never delivers drag events to a window that has
// ever been click-through-configured). The pet must keep IGNORING mouse
// events for the whole drag so macOS targets the catcher beneath it; main
// already forced that — just mirror it and stand down until the drag ends.
window.pet.onDragMode((on) => {
  osDragActive = on;
  currentlyInteractive = false;
  if (!on) {
    dropHover = false;
    updateInteractivity();
  }
});

// Catcher relays (section E): drag hover drives the folder cue; a dropped path
// triggers the swallow + Terminal launch.
window.pet.onDropHover((on) => {
  dropHover = !!on;
});
window.pet.onDropPath((p) => {
  dropHover = false;
  eatAndOpen(p);
});

// Display sleep/wake reconcile (fixes the post-unlock position scramble): main
// pushes the window's true, on-screen-clamped position; adopt it as the new
// home and settle there so gaze, click-through and wandering all re-anchor.
window.pet.onResyncPos((p) => {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  walkTarget = null;
  returningHome = false;
  pendingMove = null;
  clearTimeout(state.phaseTimer);
  clearTimeout(state.resumeTimer);
  state.pos = { x: p.x, y: p.y };
  state.home = { x: p.x, y: p.y };
  if (!state.paused && !state.dragging) enterRest();
});

// Screen locked/asleep (on=true) → stand the scheduler down and settle to eyes;
// woken (on=false) → resume the rest/active cycle. The authoritative position
// fix arrives separately via onResyncPos on wake.
window.pet.onPowerSleep((on) => {
  powerSleep = !!on;
  if (on) {
    clearTimeout(state.phaseTimer);
    clearTimeout(state.resumeTimer);
    walkTarget = null;
    returningHome = false;
    pendingMove = null;
    setClip(REST);
  } else if (!state.paused && !state.dragging) {
    enterRest();
  }
});

// ---- Claude Code status layer (section D) -----------------------------------
//
// Maps forwarded hook events (from EVERY Claude Code session on the machine —
// hooks live in ~/.claude/settings.json) onto per-session state, then derives
// what the chip shows and whether the scheduler is held. A live drag always
// wins, so holds never fight the user.

// Enter an attentive REST hold: pause the scheduler and sit in the idle
// pose. No-op visually if a drag is in progress.
function enterClaudeHold() {
  clearTimeout(state.phaseTimer);
  clearTimeout(state.resumeTimer);
  clearTimeout(claude.resumeTimer);
  claude.resumeTimer = null;
  walkTarget = null;
  returningHome = false;
  // 身体姿态改由 refreshClaude 按 claude.display 调 applyClaudeBody 驱动
  // （working→原地踏步，waiting→抱臂待机），不再在这里固定 eyes。
}

// 把 Claude 的合并状态映射到河马身体姿态（事件驱动）。
// working：原地踏步几轮后由 onActivityDone 接回注视 REST（长期状态靠头顶芯片维持）；
// waiting：切到抱臂待机并循环保持，表示「叉手等你确认」；其余兜底回 eyes。
// 拖拽中不抢身体（用户操作优先）。
function applyClaudeBody(display) {
  if (state.dragging) return;
  if (display === 'waiting') {
    setClip('scratch'); // 抱臂待机，loopTarget=0 → 开放循环，定格保持
  } else if (display === 'working') {
    walkTarget = null; // 原地，不位移
    setClip('walk', { loopTarget: 3 }); // 踏步 3 轮 → onActivityDone 接回 eyes
  } else {
    setClip(REST);
  }
}

// A task finished: flash done with its label and yip once. The chip/scheduler
// afterlife is handled by refreshClaude (other sessions may still be running).
function fireClaudeDone(label) {
  claude.doneLabel = label || '任务完成';
  claude.doneUntil = performance.now() + DONE_FLASH_MS;
  if (!state.dragging && !state.paused) {
    state.activitiesLeft = 1; // 一次庆祝（review：任务完成、结果就绪）
    setClip('cheer', { loopTarget: 1 });
  }
}

// Recompute the merged display from live sessions and manage the scheduler
// hold/resume transitions. Called after every event and periodically (stale
// sessions from killed terminals are forgotten).
function refreshClaude() {
  const wall = Date.now();
  for (const [sid, s] of claude.sessions) {
    if (wall - s.last > SESSION_STALE_MS) claude.sessions.delete(sid);
  }
  const all = [...claude.sessions.values()];
  const waiting = all.filter((s) => s.status === 'waiting');
  const working = all.filter((s) => s.status === 'working');
  if (waiting.length) {
    // Anything waiting for the user beats everything else.
    claude.display = 'waiting';
    claude.taskLabel = waiting[waiting.length - 1].label;
    claude.taskExtra = all.length - 1;
  } else if (working.length) {
    working.sort((a, b) => a.last - b.last);
    claude.display = 'working';
    claude.taskLabel = working[working.length - 1].label;
    claude.taskExtra = working.length - 1;
  } else {
    claude.display = 'idle';
    claude.taskLabel = '';
    claude.taskExtra = 0;
  }

  // Hold while sessions are live; resume once the last one is gone (after its
  // done flash has played out).
  if (claudeHolding()) {
    if (!claude.holding) {
      claude.holding = true;
      enterClaudeHold();
    }
    // 按合并状态驱动身体姿态，仅在 display 变化时切换（避免每个事件都重置动画）。
    // done 闪烁期间先让庆祝（cheer）播完再切，不打断。
    const flashing = performance.now() < claude.doneUntil;
    if (!flashing && claude.display !== claude.bodyDisplay) {
      claude.bodyDisplay = claude.display;
      applyClaudeBody(claude.display);
    }
  } else if (claude.holding) {
    claude.holding = false;
    claude.bodyDisplay = null;
    const wait =
      Math.max(0, claude.doneUntil - performance.now()) + CHIP_FADE_MS;
    clearTimeout(claude.resumeTimer);
    claude.resumeTimer = setTimeout(() => {
      claude.resumeTimer = null;
      if (!state.paused && !state.dragging && !claudeHolding()) enterRest();
    }, wait);
  }
}

// Forget stale sessions even when no events arrive (e.g. a killed terminal).
setInterval(refreshClaude, 60 * 1000);

// Derive a session's task label: the prompt text (whitespace collapsed) or,
// when that's unavailable (pet launched mid-task / Notification-only), the
// project folder's name from cwd.
function taskLabelFrom(prompt, cwd) {
  // 只显示项目目录名——prompt 前几字没有意义，指示器图标已说明状态
  const parts = (cwd || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'Claude';
}

window.pet.onClaudeEvent(({ event, cwd, prompt, sessionId }) => {
  const sid = sessionId || cwd || 'default';
  const wall = Date.now();
  const s = claude.sessions.get(sid);
  switch (event) {
    case 'UserPromptSubmit':
      // A turn began (new or existing session) → that session is running.
      claude.sessions.set(sid, {
        status: 'working',
        label: taskLabelFrom(prompt, cwd),
        last: wall,
      });
      break;
    case 'PostToolUse':
      // Tool activity proves the session is running (also flips a 'waiting'
      // session back after the user approved, and adopts sessions the pet
      // never saw start).
      if (s) {
        s.status = 'working';
        s.last = wall;
      } else {
        claude.sessions.set(sid, {
          status: 'working',
          label: taskLabelFrom(null, cwd),
          last: wall,
        });
      }
      break;
    case 'Notification':
      // Claude is blocked on the user (permission / question).
      if (s) {
        s.status = 'waiting';
        s.last = wall;
      } else {
        claude.sessions.set(sid, {
          status: 'waiting',
          label: taskLabelFrom(null, cwd),
          last: wall,
        });
      }
      break;
    case 'Stop':
      // The turn finished → that task succeeded: done flash + yip.
      claude.sessions.delete(sid);
      fireClaudeDone(s ? s.label : taskLabelFrom(prompt, cwd));
      break;
    case 'SessionEnd':
      // Terminal/session closed — clear silently (no celebration).
      claude.sessions.delete(sid);
      break;
    case 'SubagentStop':
    default:
      // Ignore SubagentStop (and anything unrecognized) to avoid noise.
      break;
  }
  refreshClaude();
});

// ---- 主动互动（idle chatter）------------------------------------------------
//
// 每隔 [min, min+20] 分钟随机冒一个 speech 气泡，配一声很轻的「叮」。文案分四类：
// 久坐提醒 / 关心陪伴 / 卖萌唠嗑 / 按时段问候。屏幕休眠、拖拽、Claude 任务占用
// 气泡时本轮跳过（直接重排），不打断正在进行的事。

// 文案保持短（气泡单行，最宽约 10 个汉字）。
const CHATTER = {
  sit: ['坐久啦，起来动动～', '记得喝口水哦', '伸个懒腰吧！', '抬头远眺一下眼睛'],
  care: ['今天也辛苦啦', '别太累，我陪着你', '深呼吸，放松一下～', '你已经很棒啦'],
  cute: ['{name}在偷看你～', '摸摸我嘛', '嘿，被我发现摸鱼', '哼哧哼哧…'],
};

// 按时段问候：触发时按当前小时挑一池。
function timeGreeting() {
  const h = new Date().getHours();
  if (h < 5) return ['夜深了，早点睡呀', '别熬太晚哦'];
  if (h < 11) return ['早上好呀！', '新的一天，加油！'];
  if (h < 14) return ['中午啦，吃饭了吗', '午休一下吧～'];
  if (h < 18) return ['下午好～', '喝杯茶提提神？'];
  if (h < 23) return ['晚上好呀', '忙完了吗？歇会儿'];
  return ['夜深了，早点睡呀', '别熬太晚哦'];
}

function pickChatter() {
  const pools = [CHATTER.sit, CHATTER.care, CHATTER.cute, timeGreeting()];
  const pool = pools[Math.floor(Math.random() * pools.length)];
  const msg = pool[Math.floor(Math.random() * pool.length)];
  return msg.replace(/\{name\}/g, charName);
}

// 很轻的柔和「叮」：Web Audio 合成一个正弦音 + 快速衰减，避免突兀。首个用户手势
// 之前 AudioContext 可能被挂起，能 resume 就 resume，不行就静默。
let audioCtx = null;
function playDing() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.1);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.02); // 很轻
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.55);
  } catch (_) {
    /* 没声音也不影响 */
  }
}

function scheduleChatter() {
  clearTimeout(idleChatter.timer);
  if (!idleChatter.enabled) return;
  const min = Math.max(1, idleChatter.minMinutes);
  // 实际触发落在 [min, min+20] 分钟随机，保留「不定时」的惊喜感。
  const ms = (min + Math.random() * 20) * 60 * 1000;
  idleChatter.timer = setTimeout(fireChatter, ms);
}

function fireChatter() {
  // 占用中（休眠 / 拖拽 / Claude 气泡）本轮跳过，避免抢气泡或在锁屏时出声。
  const busy =
    powerSleep ||
    state.dragging ||
    claudeHolding() ||
    performance.now() < claude.doneUntil;
  if (idleChatter.enabled && !busy) {
    speechBubble.text = pickChatter();
    speechBubble.until = performance.now() + SPEECH_HOLD_MS;
    playDing();
  }
  scheduleChatter();
}

// 设置面板保存后即时下发：更新开关/频率并重排定时器。
window.pet.onIdleChatterConfig((c) => {
  if (!c) return;
  idleChatter.enabled = c.enabled !== false;
  idleChatter.minMinutes = Number(c.minMinutes) || 25;
  scheduleChatter();
});

// 右键菜单切换角色：主进程下发新角色 {id, name} → 热重载素材 + 更新文案名。
window.pet.onCharacterChange((ch) => {
  if (!ch || !ch.id) return;
  if (ch.name) charName = ch.name;
  switchCharacter(ch.id);
});

// ---- Boot -------------------------------------------------------------------

async function start() {
  // 当前角色：问主进程（读 config.character.id），拿不到就回退 hema。
  let charId = 'hema';
  try {
    const ch = await window.pet.getCharacter();
    if (ch && ch.id) charId = ch.id;
    if (ch && ch.name) charName = ch.name;
  } catch (_) {
    /* 主进程未就绪：用默认角色 */
  }
  currentCharId = charId;
  await loadAllFrames(charId, images);
  loadBondState();

  // Seed local position from the real window position; that spot is home.
  const [wx, wy] = await window.pet.getPos();
  state.pos = { x: wx, y: wy };
  state.home = { x: wx, y: wy };

  // Seed the cursor sample (screen points) so the first hover test and gaze
  // have data before the poll's first tick.
  try {
    const c = await window.pet.getCursor();
    latestCursor = { x: c.x, y: c.y };
  } catch (_) {
    /* fall back to the -1 sentinel; pointermove / onCursor will populate it */
  }

  // 拉一次主动互动配置并起定时器（设置面板改动后会再下发覆盖）。
  try {
    const ic = await window.pet.getIdleChatterConfig();
    if (ic) {
      idleChatter.enabled = ic.enabled !== false;
      idleChatter.minMinutes = Number(ic.minMinutes) || 25;
    }
  } catch (_) {
    /* 拿不到就用默认（开，25 分钟） */
  }
  scheduleChatter();

  // Begin in REST and start the render loop.
  enterRest();
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

start();
