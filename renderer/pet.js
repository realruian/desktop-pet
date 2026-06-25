// pet.js — animation engine + behavior state machine for the corgi.
//
// Responsibilities:
//   1. Preload all sprite frames, then drive a requestAnimationFrame render loop.
//   2. Bake the horizontal flip INTO the canvas (never via CSS) so the alpha
//      hit-test samples exactly the pixels the user sees.
//   3. Pixel-perfect click-through: toggle window mouse-ignore based on whether
//      the cursor is over an opaque body pixel.
//   4. Manual 1:1 dragging via Pointer Events (main process moves the window).
//   5. A phase-based behavior state machine: the dog RESTs ~half the time (eyes
//      tracking the cursor + subtle breathing), punctuated by short bursts of
//      activity (walk / scratch / bark / roll).

'use strict';

// ---- Constants --------------------------------------------------------------

const WIN = 160; // window + canvas size (square), matches main.js
const SRC = 420; // source frame size (px)
// The dog is drawn smaller than the window, anchored bottom-center — the spare
// headroom hosts the status chip, and the (transparent) window never shows.
const DOG = 120; // drawn dog size (px)
const DOG_X = (WIN - DOG) / 2; // dog draw origin inside the canvas
const DOG_Y = WIN - DOG;
const WALK_SPEED = 130; // px/s while walking

// Autonomous wandering. true = the dog takes short strolls NEAR ITS HOME spot
// and always walks back home before resting again, so it never drifts across
// the screen. Strolls are strictly HORIZONTAL (the walk art is a side profile —
// diagonal/vertical sliding looks wrong), so the dog paces left/right along its
// home's level. Dragging it somewhere makes that spot the new home. false =
// strictly in-place activities only.
const WANDER = true;
const HOME_RANGE = 240; // max stroll distance from home (px, horizontal)
const STROLL_MIN = 60; // min stroll distance — keep walks visible
const HOME_EPS = 8; // "close enough to home" — skip the walk back
const ALPHA_THRESHOLD = 30; // alpha above this counts as "over the body"
const TAP_SLOP = 4; // px of movement below which a press counts as a tap
const RESUME_DELAY = 600; // ms to wait after a real drag before resting again

// Phase scheduler (v2): rest in meaningful stretches, then a short active burst.
const REST_MIN = 6000; // min REST phase duration (ms)
const REST_MAX = 12000; // max REST phase duration (ms)

// Bond / expression unlocks. Time only counts while the user is actively
// interacting with 多吉 (hovering over the body or dragging it around).
const BOND_STORAGE_KEY = 'duoji.bond.v1';
const BOND_SAVE_EVERY_MS = 3000;
const EXPRESSION_HOLD_LOOPS = 2;
const EXPRESSION_UNLOCKS = [
  { clip: 'tearful', label: '泪眼汪汪', thresholdMs: 60 * 1000 },
  { clip: 'tearful2', label: '委屈巴巴', thresholdMs: 3 * 60 * 1000 },
  { clip: 'tearful3', label: '想贴贴', thresholdMs: 5 * 60 * 1000 },
  { clip: 'tearful4', label: '舍不得你', thresholdMs: 8 * 60 * 1000 },
  { clip: 'bone', label: '啃骨头', thresholdMs: 10 * 60 * 1000 },
];

// Breathing during REST: chest rises/falls, feet planted at the baseline.
const BREATH_AMT = 0.02; // ±2% vertical scale
const BREATH_PERIOD = 3200; // ms per breath cycle
const BASELINE = 388; // ground line in 420px source space (shared by all clips)

// Eyes / gaze (REST): frames are NAMED by the direction the dog actually looks
// (from the source art), so we just match the cursor vector to the closest named
// direction — no angle-sign guesswork. Vectors are in SCREEN coords (x right, y
// DOWN). 'forward' (正视) when the cursor is near; 'nose' (看鼻子, cross-eyed)
// when it's right on the dog's face. Down-right has no art frame → nearest wins.
const GAZE_FADE = 0.12; // cross-fade duration on gaze change (s, ≈120ms)
const GAZE_DIRS = [
  { name: 'right', dx: 1, dy: 0 },
  { name: 'upright', dx: 1, dy: -1 },
  { name: 'up', dx: 0, dy: -1 },
  { name: 'upleft', dx: -1, dy: -1 },
  { name: 'left', dx: -1, dy: 0 },
  { name: 'downleft', dx: -1, dy: 1 },
  { name: 'down', dx: 0, dy: 1 },
];
const GAZE_FORWARD = 'forward';
const GAZE_NOSE = 'nose';
const GAZE_NEAR_PX = 75; // cursor within this of the dog's center → look 'forward'
const GAZE_NOSE_PX = 30; // cursor this close (on the face) → cross-eyed 'nose'
const EYES_FRAMES = [
  ...GAZE_DIRS.map((g) => g.name),
  GAZE_FORWARD,
  GAZE_NOSE,
];

// Claude Code status layer (section D). While any session is live the
// autonomous scheduler is paused and the dog holds an attentive REST (eyes
// still track the cursor), with a small status chip floating above its head.
//
// Status chip: one compact row above the dog's head — [tiny DRAWN indicator]
// [task label]. NO progress bar: Claude Code exposes no real percentage, so
// the chip only claims what it actually knows — running (blue spinner),
// needs you (amber pulse), finished (green check flash + a yip).
//
// Events arrive from EVERY Claude Code session on the machine (global hooks),
// so state is tracked PER SESSION and the chip shows the merged picture:
// any session waiting beats working; multiple running shows a ＋N suffix;
// each completion flashes ✅ with that task's label (and a bark), then the
// chip returns to the remaining tasks or fades away.
const CHIP_W = 92; // chip width (WIN-space px), centered above the head
const CHIP_H = 16; // chip height (single row); the dog's crown is at y≈21
const CHIP_Y = 0; // chip top
const CHIP_PAD = 7; // left/right inner padding
const CHIP_LABEL_FONT = '9px -apple-system, "PingFang SC", system-ui, sans-serif';
const CHIP_FADE_MS = 450; // chip fade-out once everything is done
const DONE_FLASH_MS = 2200; // how long each task's ✅ flash holds
const SESSION_STALE_MS = 15 * 60 * 1000; // forget sessions silent this long
const CHIP_COLOR = {
  working: '#7aa2ff', // calm blue — running
  waiting: '#ffcc66', // amber — needs you
  done: '#5fd07a', // green — finished
};

// Animation clips: frame count + playback fps. Art faces LEFT by default.
// (REST uses the separately-loaded, gaze-named `images.eyes` set — see below.)
const CLIPS = {
  walk: { fps: 10, frames: 8, faces: 'left' }, // side profile（河马向左走，向右自动翻转）
  scratch: { fps: 8, frames: 6, faces: 'front' }, // 河马：抱臂待机
  bark: { fps: 9, frames: 4, faces: 'front' }, // 河马：挥手打招呼
  roll: { fps: 8, frames: 6, faces: 'front' }, // 河马：微笑转头卖萌
  bone: { fps: 8, frames: 5, faces: 'front' }, // 河马：捂嘴欢呼（当作开心接食）
  tearful: {
    fps: 1,
    frames: ['../assets/expressions/tearful.png'],
    faces: 'front',
  },
  tearful2: {
    fps: 1,
    frames: ['../assets/expressions/tearful-2.png'],
    faces: 'front',
  },
  tearful3: {
    fps: 1,
    frames: ['../assets/expressions/tearful-3.png'],
    faces: 'front',
  },
  tearful4: {
    fps: 1,
    frames: ['../assets/expressions/tearful-4.png'],
    faces: 'front',
  },
};

// Weighted activity picks for an ACTIVE-phase burst. `walk` (the only activity
// that moves the window) is included only when WANDER is on; otherwise the dog
// stays put and an active burst is just an in-place animation.
const ACTIVITY_WEIGHTS = [
  ...(WANDER ? [{ name: 'walk', weight: 45 }] : []),
  { name: 'scratch', weight: 18 },
  { name: 'bark', weight: 18 },
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
// the DOG-sized, bottom-anchored placement.
const BASELINE_WIN = DOG_Y + BASELINE * (DOG / SRC);

// ---- Sprite preloading ------------------------------------------------------

// images[clip] = Image[] (index 0..frames-1)
const images = {};

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

function loadAllFrames() {
  const tasks = [];
  // Numbered animation clips.
  for (const clip of Object.keys(CLIPS)) {
    images[clip] = [];
    const frames = CLIPS[clip].frames;
    if (Array.isArray(frames)) {
      frames.forEach((src, i) => {
        images[clip][i] = loadOne(src, tasks);
      });
    } else {
      for (let i = 1; i <= frames; i++) {
        const name = String(i).padStart(2, '0') + '.png';
        images[clip][i - 1] = loadOne(`../assets/${clip}/${name}`, tasks);
      }
    }
  }
  // REST gaze frames, keyed by direction name (images.eyes[name]).
  images.eyes = {};
  for (const name of EYES_FRAMES) {
    images.eyes[name] = loadOne(`../assets/eyes/${name}.png`, tasks);
  }
  return Promise.all(tasks);
}

// ---- Local state ------------------------------------------------------------

const state = {
  pos: { x: 0, y: 0 }, // window top-left in screen points
  home: null, // the spot the dog lives at (returns here after strolls)
  facingRight: false, // art faces left; flip when true
  paused: false, // menu toggle
  dragging: false,
  clipName: 'eyes', // current animation clip ('eyes' === REST)
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

// Convenience: REST is the canonical idle, identified by the 'eyes' clip.
const isResting = () => state.clipName === 'eyes';

// True while any live Claude session holds the dog (scheduler paused). The
// done-flash is transient and does NOT count as a hold.
const claudeHolding = () => claude.sessions.size > 0;

// Walk target (window top-left we're moving toward), null when not walking.
let walkTarget = null;

// True while the current walk is the "going home" leg (it ends the ACTIVE
// phase directly instead of counting as an activity).
let returningHome = false;

// True while the screen is locked/asleep: the wander scheduler stands down so
// the dog never roams against a stale work area (its position would otherwise
// be scrambled on wake). Main reconciles the real window position on wake.
let powerSleep = false;

// Latest global cursor position in SCREEN points, fed by pet.onCursor (~30 Hz)
// and refreshed inline by pointermove (which carries screen coords too). Drives
// BOTH the resting gaze and the click-through hit-test — the hit-test derives
// client coords by subtracting the window position rather than relying on
// mousemove events, because macOS stops delivering mousemove during a system
// drag session while the main process's cursor poll keeps flowing. That is what
// lets a dragged file un-ignore the window and land on the dog (section E).
// -1 means "no sample yet" → look straight ahead (East).
let latestCursor = { x: -1, y: -1 };

// Gaze cross-fade bookkeeping: when the chosen gaze direction changes we fade
// from the previous named frame to the new one over GAZE_FADE seconds.
const gaze = { prev: GAZE_FORWARD, cur: GAZE_FORWARD, t: 1 }; // t in [0,1]; 1 == fully on `cur`

// Claude Code status (section D), tracked per session (global hooks mean any
// number of Claude Code tasks can be live at once across projects).
const claude = {
  sessions: new Map(), // session id -> { status:'working'|'waiting', label, last }
  display: 'idle', // derived: 'idle' | 'working' | 'waiting'
  taskLabel: '', // merged label shown while working/waiting
  taskExtra: 0, // how many MORE tasks are live beyond the labeled one (＋N)
  doneUntil: 0, // performance.now() end of the current ✅ flash
  doneLabel: '', // label shown during the flash
  holding: false, // scheduler-hold transition tracking
  resumeTimer: null, // setTimeout id resuming the scheduler after the last task
};

const unlockNotice = {
  until: 0,
  label: '',
};

// True while a file/folder is being dragged over the dog (section E): show a
// 📂 glyph and a tiny scale-up cue inviting the drop.
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
// non-finite move-to frames, so the dog can stutter but never crash.
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

// Choose the gaze frame NAME by matching the dog→cursor vector to the closest
// named direction. Vectors are in screen coords (x right, y DOWN), so there is no
// angle-sign ambiguity: we just pick the art frame that looks most toward the
// cursor. Cursor on/near the dog → 'nose' (cross-eyed) / 'forward'.
function gazeName() {
  if (latestCursor.x < 0) return GAZE_FORWARD; // no cursor sample yet
  const centerX = state.pos.x + WIN / 2; // dog is horizontally centered
  const centerY = state.pos.y + DOG_Y + DOG / 2; // visual center of the dog
  const vx = latestCursor.x - centerX;
  const vy = latestCursor.y - centerY;
  const len = Math.hypot(vx, vy);
  if (len < GAZE_NOSE_PX) return GAZE_NOSE; // cursor right on the face → cross-eyed
  if (len < GAZE_NEAR_PX) return GAZE_FORWARD; // cursor near → look straight at you
  let best = GAZE_DIRS[0];
  let bestDot = -Infinity;
  for (const g of GAZE_DIRS) {
    // cosine similarity between the cursor vector and this frame's direction
    const dot = (vx * g.dx + vy * g.dy) / (len * Math.hypot(g.dx, g.dy));
    if (dot > bestDot) {
      bestDot = dot;
      best = g;
    }
  }
  return best.name;
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
// every cursor poll tick, on pointermove, and every render frame (the dog can
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
  // 420→DOG scale keeps the dog grounded with no vertical "jump" between poses.
  ctx.drawImage(img, 0, 0, src, src, DOG_X, DOG_Y, DOG, DOG);
  ctx.restore();
}

// Draw the REST pose: the gaze-selected (direction-named) eyes frame, with a soft
// cross-fade when the gaze direction changes, all under the breathing scale.
function drawRest(now) {
  const eyes = images.eyes;
  if (!eyes) return;

  // Pick the target gaze frame (by name) and start a fade if it changed.
  const want = gazeName();
  if (want !== gaze.cur) {
    gaze.prev = gaze.cur;
    gaze.cur = want;
    gaze.t = 0;
  }

  // Breathing scale, anchored at the ground baseline (feet planted, chest rises).
  const s = 1 + BREATH_AMT * Math.sin((2 * Math.PI * now) / BREATH_PERIOD);
  const cx = WIN / 2;

  ctx.save();
  ctx.translate(cx, BASELINE_WIN);
  ctx.scale(1, s);
  ctx.translate(-cx, -BASELINE_WIN);

  // Draw the outgoing frame at full opacity first so the (identical) body stays
  // fully opaque throughout the fade — only the incoming pupils blend on top.
  // This also keeps the alpha hit-test correct mid-fade.
  const prevImg = eyes[gaze.prev];
  const curImg = eyes[gaze.cur];
  if (gaze.t < 1 && prevImg && prevImg.complete && prevImg.naturalWidth) {
    ctx.globalAlpha = 1;
    ctx.drawImage(prevImg, 0, 0, SRC, SRC, DOG_X, DOG_Y, DOG, DOG);
  }
  if (curImg && curImg.complete && curImg.naturalWidth) {
    ctx.globalAlpha = Math.min(gaze.t, 1);
    ctx.drawImage(curImg, 0, 0, SRC, SRC, DOG_X, DOG_Y, DOG, DOG);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawFrame(now, dt) {
  ctx.clearRect(0, 0, WIN, WIN);

  // Drop-hover gives a tiny scale-up cue (section E), anchored at the ground
  // baseline so the feet stay planted. Baked into the canvas, so the hit-test
  // (which samples after drawing) stays pixel-accurate against the larger dog.
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
    // Advance the gaze cross-fade clock (frame chosen inside drawRest).
    gaze.t = Math.min(gaze.t + dt / GAZE_FADE, 1);
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

// The status chip: one compact row above the dog's head — a small DRAWN
// indicator (spinner / pulsing dot / check, crisp at a few px, no emoji)
// followed by the task label and an optional ＋N more-tasks suffix.
function drawStatusChip(now, alpha, mode, label, suffix) {
  const x = (WIN - CHIP_W) / 2;
  const y = CHIP_Y;
  const color = CHIP_COLOR[mode] || CHIP_COLOR.working;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Panel: dark translucent + hairline border, readable over any wallpaper.
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, CHIP_W - 1, CHIP_H - 1, 6);
  ctx.fillStyle = 'rgba(17,18,26,0.78)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Status indicator.
  const ix = x + CHIP_PAD + 3.5; // indicator center
  const iy = y + CHIP_H / 2;
  if (mode === 'working') {
    // Tiny spinner: a 270° arc revolving ~0.8 rev/s — "still running".
    const a0 = (now / 1250) * 2 * Math.PI;
    ctx.beginPath();
    ctx.arc(ix, iy, 3, a0, a0 + Math.PI * 1.5);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.stroke();
  } else if (mode === 'waiting') {
    // Amber dot, gently pulsing — needs your attention.
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 280));
    ctx.beginPath();
    ctx.arc(ix, iy, 3, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha * pulse;
    ctx.fill();
    ctx.globalAlpha = alpha;
  } else {
    // Done: green disc with a crisp white check.
    ctx.beginPath();
    ctx.arc(ix, iy, 3.6, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ix - 1.7, iy + 0.1);
    ctx.lineTo(ix - 0.4, iy + 1.5);
    ctx.lineTo(ix + 1.9, iy - 1.4);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Task label: WHICH task this status belongs to. The ＋N "more tasks" suffix
  // is drawn separately AFTER ellipsizing, so a long label can never swallow it.
  ctx.font = CHIP_LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tx = ix + 7;
  const maxW = x + CHIP_W - CHIP_PAD - tx;
  const sufW = suffix ? ctx.measureText(suffix).width + 2 : 0;
  const text = ellipsize(label || 'Claude 任务', maxW - sufW);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(text, tx, iy);
  if (suffix) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(suffix, tx + ctx.measureText(text).width + 2, iy);
  }

  ctx.restore();
}

// Draw the status chip / drop cue as an OVERLAY, after the click-through
// hit-test has already sampled the (chip-free) dog. Keeping the overlay out of
// the hit-test means it never becomes draggable nor disturbs click-through.
function drawOverlay(now) {
  // Chip visibility: a fresh completion flashes ✅ (+ its task label) for
  // DONE_FLASH_MS and takes precedence; otherwise working/waiting persist;
  // after the last task the flash fades the chip away; idle → nothing.
  let chipAlpha = 0;
  let mode = null;
  let label = '';
  let suffix = '';
  if (now < unlockNotice.until) {
    mode = 'done';
    label = unlockNotice.label;
    chipAlpha = 1;
  } else if (now < unlockNotice.until + CHIP_FADE_MS) {
    mode = 'done';
    label = unlockNotice.label;
    chipAlpha = 1 - (now - unlockNotice.until) / CHIP_FADE_MS;
  } else if (now < claude.doneUntil) {
    mode = 'done';
    label = claude.doneLabel;
    chipAlpha = 1;
  } else if (claude.display === 'working' || claude.display === 'waiting') {
    mode = claude.display;
    label = claude.taskLabel;
    if (claude.taskExtra > 0) suffix = '＋' + claude.taskExtra;
    chipAlpha = 1;
  } else if (now < claude.doneUntil + CHIP_FADE_MS) {
    mode = 'done';
    label = claude.doneLabel;
    chipAlpha = 1 - (now - claude.doneUntil) / CHIP_FADE_MS;
  }
  if (chipAlpha > 0.01 && mode)
    drawStatusChip(now, chipAlpha, mode, label, suffix);

  // Drop-hover cue: a 📂 centered over the dog inviting the drop (section E).
  if (dropHover) {
    ctx.save();
    ctx.font = '30px system-ui, "Apple Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📂', WIN / 2, DOG_Y + DOG / 2);
    ctx.restore();
  }

  // Eat animation: the dropped item's glyph accelerates into the mouth,
  // shrinking and fading as it goes (the chomp clip plays underneath).
  if (eat.active) {
    const t = (now - eat.t0) / EAT_FLY_MS;
    if (t >= 1) {
      eat.active = false;
    } else {
      const k = t * t; // ease-in: the dog sucks it in
      const mx = WIN / 2; // mouth, roughly mid-face on the front-facing clip
      const my = DOG_Y + DOG * 0.5;
      ctx.save();
      ctx.globalAlpha = 1 - 0.3 * t;
      ctx.font =
        Math.max(4, 28 * (1 - 0.85 * k)) +
        'px system-ui, "Apple Color Emoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        eat.glyph,
        eat.from.x + (mx - eat.from.x) * k,
        eat.from.y + (my - eat.from.y) * k
      );
      ctx.restore();
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

  // 2) Advance the current clip by elapsed time vs its fps (REST is gaze-driven,
  //    so it is skipped here and handled entirely in drawFrame/drawRest).
  if (!isResting()) advanceAnimation(dt);

  // 3) Move toward the walk target if we're walking.
  if (walkTarget) stepWalk(dt);

  // 4) Draw, then re-test click-through against the (possibly moved) sprite.
  drawFrame(now, dt);
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
      // In-place clips (scratch/bark/roll) end the activity once they've played
      // the requested loops. Walk is driven by arrival at its target instead, so
      // it ignores loopTarget here.
      if (state.loopTarget > 0 && state.clipName !== 'walk') {
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
// activities back-to-back) → REST phase → … The dog therefore rests ~half its
// time, in meaningful stretches rather than constant motion.

function setClip(name, { loopTarget = 0 } = {}) {
  state.clipName = name;
  state.frame = 0;
  state.loops = 0;
  state.loopTarget = loopTarget;
  state._frameAcc = 0;
}

// Enter (or re-enter) the REST phase: the canonical idle. Draws the gaze-tracked
// eyes + breathing, then schedules the next ACTIVE phase. Replaces v1's goIdle.
function enterRest() {
  walkTarget = null;
  returningHome = false;
  setClip('eyes');
  scheduleActive();
}

function scheduleActive() {
  clearTimeout(state.phaseTimer);
  // Don't arm the scheduler while live Claude sessions own the dog (the
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
// home first if the strolls left the dog away from its spot, then REST.
function onActivityDone() {
  if (state.paused || state.dragging) return;
  if (claudeHolding()) {
    // A one-off (e.g. the completion yip) finished during a hold: settle back
    // into the attentive REST instead of looping the clip.
    setClip('eyes');
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
  // getWorkArea is async; nothing else should drive the dog while we await it.
  window.pet.getWorkArea().then((wa) => {
    if (state.paused || powerSleep || state.dragging || claudeHolding()) return;

    // Bounds for the window top-left so the whole window stays on-screen.
    const minX = wa.x;
    const maxX = wa.x + wa.width - WIN;
    const minY = wa.y;
    const maxY = wa.y + wa.height - WIN;

    // Stroll target: HORIZONTAL only, anchored on HOME (not the current
    // position, so consecutive walks can never drift the dog away). Pick the
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
    moved =
      moved ||
      dist(downScreen, { x: e.screenX, y: e.screenY }) > TAP_SLOP;
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

  // Grab offset = cursor minus current window top-left, so the dog stays put
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
    setClip('eyes');
    return;
  }

  // Live Claude sessions were held off while the user dragged (drag always
  // wins). Re-project the attentive hold now instead of resuming the scheduler.
  if (claudeHolding()) {
    setClip('eyes'); // attentive REST; scheduler stays paused
    return;
  }

  if (!moved) {
    // A tap (petting): the dog yips once as a one-off activity, then REST.
    state.activitiesLeft = 1;
    setClip('bark', { loopTarget: 1 });
  } else {
    // A real drag: wherever you put the dog down is its new home. Settle, then
    // resume the rest/active cycle after a short beat.
    state.home = { x: wx, y: wy };
    setClip('eyes');
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
// of the pair still pets the dog (a yip), which makes a nice greeting.
canvas.addEventListener('dblclick', (e) => {
  if (!isOverBody(e.clientX, e.clientY)) return;
  window.pet.openChat();
});

// ---- File / folder drop → Terminal + Claude Code (section E) -----------------
//
// Globally swallow drags so the window never navigates to a dropped file. On
// the canvas we light up a 📂 cue and, on drop, resolve the dropped path and ask
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
  dropHover = true; // draw the 📂 glyph + scale-up cue
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

// ---- "Eat" the drop ----------------------------------------------------------
//
// Feedback for a successful drop: the item's glyph flies from the drop point
// into the dog's mouth while the bark clip plays as a chomp, then the normal
// wrap-up (walk home / rest / attentive eyes) takes over via onActivityDone.
// The Terminal launch fires immediately — it spins up behind the animation.
const EAT_FLY_MS = 460; // glyph flight time, drop point → mouth
const eat = { active: false, t0: 0, from: null, glyph: '📂' };

function eatAndOpen(p, from) {
  window.pet.openInClaude(p);

  // Folder vs file only picks the glyph; a dot-extension on the last path
  // segment is a good-enough tell without a round-trip to main.
  const base = p.split('/').pop() || '';
  eat.glyph = /\.[^.]+$/.test(base) ? '📄' : '📂';
  eat.active = true;
  eat.t0 = performance.now();
  eat.from =
    from && from.x != null
      ? { x: from.x, y: from.y }
      : { x: WIN / 2, y: DOG_Y - 4 };

  // Chomp (same one-off shape as the tap yip, two loops for a real swallow).
  if (state.paused || state.dragging) return; // glyph only; don't fight a pause
  clearTimeout(state.phaseTimer);
  walkTarget = null;
  returningHome = false;
  state.activitiesLeft = 1;
  setClip('bark', { loopTarget: 2 });
}

// ---- Menu commands from main ------------------------------------------------

window.pet.onMenuCommand((cmd) => {
  if (cmd === 'toggle-pause') {
    state.paused = !state.paused;
    if (state.paused) {
      // Force REST and stop the scheduler until resumed.
      clearTimeout(state.phaseTimer);
      clearTimeout(state.resumeTimer);
      walkTarget = null;
      returningHome = false;
      setClip('eyes');
    } else {
      enterRest();
    }
  }
});

// Global cursor feed (screen points) → aim the resting gaze AND re-test
// click-through right away (the dog may move/breathe under a still cursor).
window.pet.onCursor((p) => {
  latestCursor = { x: p.x, y: p.y };
  updateInteractivity();
});

// System-drag mode (section E): while any file drag is in flight, an
// invisible catcher window is shown at the dog's bounds to receive the drop
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

// Catcher relays (section E): drag hover drives the 📂 cue; a dropped path
// triggers the swallow + Terminal launch.
window.pet.onDropHover((on) => {
  dropHover = !!on;
});
window.pet.onDropPath((p) => {
  dropHover = false;
  eatAndOpen(p);
});

// Wake word "多吉多吉" heard (section H): a single attentive bark, same one-off
// shape as the tap yip. The chat panel pops separately; this is just the dog
// perking up to say "I'm listening".
window.pet.onWakeBark(() => {
  if (state.paused || state.dragging) return;
  clearTimeout(state.phaseTimer);
  walkTarget = null;
  returningHome = false;
  state.activitiesLeft = 1;
  setClip('bark', { loopTarget: 1 });
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
    setClip('eyes');
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

// Enter an attentive REST hold: pause the scheduler and sit with the
// gaze-tracked eyes. No-op visually if a drag is in progress.
function enterClaudeHold() {
  clearTimeout(state.phaseTimer);
  clearTimeout(state.resumeTimer);
  clearTimeout(claude.resumeTimer);
  claude.resumeTimer = null;
  walkTarget = null;
  returningHome = false;
  if (!state.dragging) setClip('eyes'); // attentive REST; eyes track cursor
}

// A task finished: flash ✅ with its label and yip once. The chip/scheduler
// afterlife is handled by refreshClaude (other sessions may still be running).
function fireClaudeDone(label) {
  claude.doneLabel = label || '任务完成';
  claude.doneUntil = performance.now() + DONE_FLASH_MS;
  if (!state.dragging && !state.paused) {
    state.activitiesLeft = 1; // a single celebratory yip
    setClip('bark', { loopTarget: 1 });
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
  // ✅ flash has played out).
  if (claudeHolding()) {
    if (!claude.holding) {
      claude.holding = true;
      enterClaudeHold();
    }
  } else if (claude.holding) {
    claude.holding = false;
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
  const p = (prompt || '').replace(/\s+/g, ' ').trim();
  if (p) return p.slice(0, 60); // ellipsized to chip width at draw time
  const parts = (cwd || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
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
      // The turn finished → that task succeeded: ✅ flash + yip.
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

// ---- Boot -------------------------------------------------------------------

async function start() {
  await loadAllFrames();
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

  // Begin in REST and start the render loop.
  enterRest();
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

start();
