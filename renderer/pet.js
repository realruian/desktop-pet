// pet.js — animation engine + behavior state machine for the corgi.
//
// Responsibilities:
//   1. Preload all sprite frames, then drive a requestAnimationFrame render loop.
//   2. Bake the horizontal flip INTO the canvas (never via CSS) so the alpha
//      hit-test samples exactly the pixels the user sees.
//   3. Pixel-perfect click-through: toggle window mouse-ignore based on whether
//      the cursor is over an opaque body pixel.
//   4. Manual 1:1 dragging via Pointer Events (main process moves the window).
//   5. A weighted wander/idle behavior state machine.

'use strict';

// ---- Constants --------------------------------------------------------------

const WIN = 200; // window + drawn-canvas size (square), matches main.js
const SRC = 420; // source frame size (px)
const WALK_SPEED = 150; // px/s while walking
const IDLE_MIN = 2500; // min idle pause before next behavior (ms)
const IDLE_MAX = 6000; // max idle pause before next behavior (ms)
const ALPHA_THRESHOLD = 30; // alpha above this counts as "over the body"
const TAP_SLOP = 4; // px of movement below which a press counts as a tap
const RESUME_DELAY = 600; // ms to wait after a real drag before wandering again

// Animation clips: frame count + playback fps. Art faces LEFT by default.
const CLIPS = {
  walk: { fps: 10, frames: 9, faces: 'left' }, // side profile
  scratch: { fps: 8, frames: 9, faces: 'front' }, // scratch[0] = idle pose
  bark: { fps: 9, frames: 9, faces: 'front' },
  roll: { fps: 8, frames: 9, faces: 'front' },
};

// Weighted behavior picks out of IDLE.
const BEHAVIOR_WEIGHTS = [
  { name: 'walk', weight: 55 },
  { name: 'scratch', weight: 15 },
  { name: 'bark', weight: 15 },
  { name: 'roll', weight: 15 },
];

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

// ---- Sprite preloading ------------------------------------------------------

// images[clip] = Image[] (index 0..frames-1)
const images = {};

function loadAllFrames() {
  const tasks = [];
  for (const clip of Object.keys(CLIPS)) {
    images[clip] = [];
    for (let i = 1; i <= CLIPS[clip].frames; i++) {
      const img = new Image();
      const name = String(i).padStart(2, '0') + '.png';
      img.src = `../assets/${clip}/${name}`;
      images[clip][i - 1] = img;
      tasks.push(
        new Promise((resolve) => {
          // Resolve on both load and error so one bad file can't hang startup.
          img.onload = resolve;
          img.onerror = resolve;
        })
      );
    }
  }
  return Promise.all(tasks);
}

// ---- Local state ------------------------------------------------------------

const state = {
  pos: { x: 0, y: 0 }, // window top-left in screen points
  facingRight: false, // art faces left; flip when true
  paused: false, // menu toggle
  dragging: false,
  clipName: 'scratch', // current animation clip
  frame: 0, // current frame index within the clip
  loops: 0, // completed loops of the current clip
  loopTarget: 0, // loops to play before returning to IDLE (0 = open-ended)
  behaviorTimer: null, // setTimeout id for the next behavior
  resumeTimer: null, // setTimeout id for post-drag resume
};

// Walk target (window top-left we're moving toward), null when not walking.
let walkTarget = null;

// Last cursor position in canvas/CSS coords; updated on every pointermove.
let lastCursor = { x: -1, y: -1 };

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

function pickBehavior() {
  const total = BEHAVIOR_WEIGHTS.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total;
  for (const b of BEHAVIOR_WEIGHTS) {
    if ((r -= b.weight) < 0) return b.name;
  }
  return 'scratch';
}

// ---- Pixel-perfect hit test -------------------------------------------------

// Map client (CSS) coords to canvas internal pixels (accounting for rect scale
// and DPR), then sample the alpha channel of the currently-rendered frame.
// Because the flip is baked into the canvas, sampled pixels match what's shown.
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

// Re-evaluate click-through against the last known cursor position. Called both
// on pointermove and every render frame (the dog can move under a still cursor).
function updateInteractivity() {
  if (state.dragging) return; // never toggle ignore mid-drag
  if (lastCursor.x < 0) return; // no cursor sample yet
  const over = isOverBody(lastCursor.x, lastCursor.y);
  if (over !== currentlyInteractive) {
    currentlyInteractive = over;
    window.pet.setIgnore(!over); // interactive = NOT ignoring mouse
  }
}

// ---- Rendering --------------------------------------------------------------

function drawFrame() {
  const img = images[state.clipName][state.frame];
  ctx.clearRect(0, 0, WIN, WIN);
  if (!img || !img.complete || img.naturalWidth === 0) return;

  ctx.save();
  if (state.facingRight) {
    // Bake the horizontal flip into the canvas so the hit-test stays accurate.
    ctx.translate(WIN, 0);
    ctx.scale(-1, 1);
  }
  // Uniform anchoring: every clip shares the 420px baseline, so a straight
  // 420→WIN scale keeps the dog grounded with no vertical "jump" between poses.
  ctx.drawImage(img, 0, 0, SRC, SRC, 0, 0, WIN, WIN);
  ctx.restore();
}

let lastTime = performance.now();

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1); // seconds, clamped
  lastTime = now;

  // 1) Apply any throttled drag move (1:1 with the cursor).
  if (pendingMove) {
    window.pet.moveTo(pendingMove.x, pendingMove.y);
    state.pos.x = pendingMove.x;
    state.pos.y = pendingMove.y;
    pendingMove = null;
  }

  // 2) Advance the current clip by elapsed time vs its fps.
  advanceAnimation(dt);

  // 3) Move toward the walk target if we're walking.
  if (walkTarget) stepWalk(dt);

  // 4) Draw, then re-test click-through against the (possibly moved) sprite.
  drawFrame();
  updateInteractivity();

  requestAnimationFrame(loop);
}

function advanceAnimation(dt) {
  const clip = CLIPS[state.clipName];
  state._frameAcc = (state._frameAcc || 0) + dt;
  const frameDur = 1 / clip.fps;
  while (state._frameAcc >= frameDur) {
    state._frameAcc -= frameDur;
    state.frame++;
    if (state.frame >= clip.frames) {
      state.frame = 0;
      state.loops++;
      // For in-place clips (scratch/bark/roll) with a loop target, return to
      // IDLE once we've played the requested number of loops. Walk is driven by
      // arrival at its target instead, so it ignores loopTarget.
      if (state.loopTarget > 0 && state.clipName !== 'walk') {
        if (state.loops >= state.loopTarget) {
          goIdle();
          return;
        }
      }
    }
  }
}

function stepWalk(dt) {
  const to = walkTarget;
  const d = dist(state.pos, to);
  if (d <= 3) {
    // Snap to target and return to idle.
    state.pos.x = to.x;
    state.pos.y = to.y;
    window.pet.moveTo(to.x, to.y);
    walkTarget = null;
    goIdle();
    return;
  }
  const step = WALK_SPEED * dt;
  const nx = state.pos.x + ((to.x - state.pos.x) / d) * step;
  const ny = state.pos.y + ((to.y - state.pos.y) / d) * step;
  state.pos.x = nx;
  state.pos.y = ny;
  window.pet.moveTo(nx, ny);
}

// ---- Behavior state machine -------------------------------------------------

function setClip(name, { loopTarget = 0 } = {}) {
  state.clipName = name;
  state.frame = 0;
  state.loops = 0;
  state.loopTarget = loopTarget;
  state._frameAcc = 0;
}

// Enter IDLE: resting pose (scratch[0]), then schedule the next behavior.
function goIdle() {
  walkTarget = null;
  setClip('scratch');
  state.frame = 0;
  scheduleNext();
}

function scheduleNext() {
  clearTimeout(state.behaviorTimer);
  if (state.paused || state.dragging) return;
  const delay = rand(IDLE_MIN, IDLE_MAX);
  state.behaviorTimer = setTimeout(startBehavior, delay);
}

async function startBehavior() {
  if (state.paused || state.dragging) return;
  const choice = pickBehavior();

  if (choice === 'walk') {
    await startWalk();
  } else {
    // scratch / bark / roll: play in place for 1–2 loops, then IDLE.
    setClip(choice, { loopTarget: Math.random() < 0.5 ? 1 : 2 });
  }
}

async function startWalk() {
  // Re-query the work area each walk so display/resolution changes are honored.
  const wa = await window.pet.getWorkArea();

  // Bounds for the window top-left so the whole window stays on-screen.
  const minX = wa.x;
  const maxX = wa.x + wa.width - WIN;
  const minY = wa.y;
  const maxY = wa.y + wa.height - WIN;

  // Mostly-horizontal target with slight vertical drift (natural side-view walk).
  const tx = rand(minX, maxX);
  const ty = clamp(state.pos.y + rand(-0.18, 0.18) * wa.height, minY, maxY);

  state.facingRight = tx > state.pos.x;
  walkTarget = { x: tx, y: ty };
  setClip('walk'); // looped; arrival at target ends it
}

// ---- Pointer / drag handling ------------------------------------------------

canvas.addEventListener('pointermove', (e) => {
  // These arrive even while the window ignores mouse events (forward:true).
  // Store raw client coords; isOverBody() maps them to canvas pixels.
  lastCursor = { x: e.clientX, y: e.clientY };

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

  // Pause the wander AI while held and keep the window interactive.
  clearTimeout(state.behaviorTimer);
  clearTimeout(state.resumeTimer);
  walkTarget = null;
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

  if (!moved) {
    // A tap (petting): the dog yips once, then idles.
    setClip('bark', { loopTarget: 1 });
  } else {
    // A real drag: settle, then resume wandering after a short beat.
    setClip('scratch');
    state.resumeTimer = setTimeout(() => {
      goIdle();
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

// ---- Menu commands from main ------------------------------------------------

window.pet.onMenuCommand((cmd) => {
  if (cmd === 'toggle-pause') {
    state.paused = !state.paused;
    if (state.paused) {
      // Force IDLE and stop scheduling until resumed.
      clearTimeout(state.behaviorTimer);
      walkTarget = null;
      setClip('scratch');
    } else {
      goIdle();
    }
  }
});

// ---- Boot -------------------------------------------------------------------

async function start() {
  await loadAllFrames();

  // Seed local position from the real window position.
  const [wx, wy] = await window.pet.getPos();
  state.pos = { x: wx, y: wy };

  // Seed the cursor sample so the first hover test has data. The cursor is in
  // screen points; convert to canvas-local (client) coords by subtracting the
  // window's top-left.
  try {
    const c = await window.pet.getCursor();
    lastCursor = { x: c.x - wx, y: c.y - wy };
  } catch (_) {
    /* fall back to the -1 sentinel; pointermove will populate it */
  }

  // Begin in IDLE and start the render loop.
  goIdle();
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

start();
