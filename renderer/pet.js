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

const WIN = 160; // window + drawn-canvas size (square), matches main.js
const SRC = 420; // source frame size (px)
const WALK_SPEED = 150; // px/s while walking

// Autonomous wandering. false = the dog stays put in one spot (active bursts use
// only in-place animations); it never walks the window across the screen on its
// own. You can always still drag it yourself. Set true to re-enable roaming.
const WANDER = false;
const ALPHA_THRESHOLD = 30; // alpha above this counts as "over the body"
const TAP_SLOP = 4; // px of movement below which a press counts as a tap
const RESUME_DELAY = 600; // ms to wait after a real drag before resting again

// Phase scheduler (v2): rest in meaningful stretches, then a short active burst.
const REST_MIN = 6000; // min REST phase duration (ms)
const REST_MAX = 12000; // max REST phase duration (ms)

// Breathing during REST: chest rises/falls, feet planted at the baseline.
const BREATH_AMT = 0.02; // ±2% vertical scale
const BREATH_PERIOD = 3200; // ms per breath cycle
const BASELINE = 388; // ground line in 420px source space (shared by all clips)

// Eyes / gaze (REST): 9 front-facing frames, body identical, only pupils move.
const GAZE_FADE = 0.12; // cross-fade duration on gaze-frame change (s, ≈120ms)
const GAZE_STEP_DEG = 40; // angular size of each gaze frame (~360/9)
const GAZE_FRAMES = 9;

// Claude Code status layer (section D). When non-idle the autonomous scheduler
// is paused and the dog holds an attentive REST (eyes still track the cursor),
// with a small status glyph near its head.
const CLAUDE_GLYPH = {
  working: '⚙️',
  waiting: '❗',
  done: '✅',
};
const CLAUDE_DONE_GLYPH_MS = 1500; // how long the ✅ shows on completion
const CLAUDE_DONE_CLEAR_MS = 4000; // when 'done' clears → scheduler resumes

// Animation clips: frame count + playback fps. Art faces LEFT by default.
// `eyes` is the REST clip — front-facing; its frame is chosen by gaze, not fps.
const CLIPS = {
  walk: { fps: 10, frames: 9, faces: 'left' }, // side profile
  scratch: { fps: 8, frames: 9, faces: 'front' },
  bark: { fps: 9, frames: 9, faces: 'front' },
  roll: { fps: 8, frames: 9, faces: 'front' },
  eyes: { fps: 1, frames: 9, faces: 'front' }, // REST; gaze-driven, see drawRest
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

// Baseline expressed in the WIN-space draw coordinates (anchor for breathing).
const BASELINE_WIN = BASELINE * (WIN / SRC);

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
  clipName: 'eyes', // current animation clip ('eyes' === REST)
  frame: 0, // current frame index within the clip
  loops: 0, // completed loops of the current clip
  loopTarget: 0, // loops to play before ending the activity (0 = open-ended)
  phaseTimer: null, // setTimeout id ending the current REST phase
  resumeTimer: null, // setTimeout id for post-drag resume
  activitiesLeft: 0, // activities remaining in the current ACTIVE phase
};

// Convenience: REST is the canonical idle, identified by the 'eyes' clip.
const isResting = () => state.clipName === 'eyes';

// True while a Claude status is holding the dog (scheduler paused). 'done' is a
// transient one-shot, so it does NOT count as a hold — only working/waiting do.
const claudeHolding = () =>
  claude.status === 'working' || claude.status === 'waiting';

// Walk target (window top-left we're moving toward), null when not walking.
let walkTarget = null;

// Last cursor position in canvas/CSS coords; updated on every pointermove.
let lastCursor = { x: -1, y: -1 };

// Latest global cursor position in SCREEN points, fed by pet.onCursor (~30 Hz).
// Used to aim the resting dog's gaze (independent of lastCursor, which is the
// canvas-local sample used for hit-testing). Seeded to the screen center-ish on
// first real sample; -1 means "no sample yet" → look straight ahead (East).
let latestCursor = { x: -1, y: -1 };

// Gaze cross-fade bookkeeping: when the computed frame changes we fade from the
// previous pupil position to the new one over GAZE_FADE seconds.
const gaze = { prev: 0, cur: 0, t: 1 }; // t in [0,1]; 1 == fully on `cur`

// Claude Code status (section D). 'idle' === the v2 autonomous scheduler is in
// charge; 'working'/'waiting' hold an attentive REST; 'done' is a one-shot
// (bark + ✅) that takes precedence, then clears back to the scheduler.
const claude = {
  status: 'idle', // 'idle' | 'working' | 'waiting' | 'done'
  glyphUntil: 0, // performance.now() ms until which the glyph is drawn
  clearTimer: null, // setTimeout id that returns 'done' → idle
};

// True while a file/folder is being dragged over the dog (section E): show a
// 📂 glyph and a tiny scale-up cue inviting the drop.
let dropHover = false;

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

function pickActivity() {
  const total = ACTIVITY_WEIGHTS.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total;
  for (const b of ACTIVITY_WEIGHTS) {
    if ((r -= b.weight) < 0) return b.name;
  }
  return 'scratch';
}

// Map the cursor direction (from the dog's center) to a 0-based gaze frame.
// frame 01 == looking East/right; even ~40° steps CCW (up = positive).
function gazeFrameIndex() {
  // No cursor sample yet → look straight ahead (East == frame 0).
  if (latestCursor.x < 0) return 0;
  const centerX = state.pos.x + WIN / 2;
  const centerY = state.pos.y + WIN / 2;
  const angleDeg =
    (Math.atan2(-(latestCursor.y - centerY), latestCursor.x - centerX) *
      180) /
      Math.PI +
    360;
  const a = angleDeg % 360;
  return ((Math.round(a / GAZE_STEP_DEG) % GAZE_FRAMES) + GAZE_FRAMES) % GAZE_FRAMES;
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

// Re-evaluate click-through against the last known cursor position. Called both
// on pointermove and every render frame (the dog can move/breathe under a still
// cursor).
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

// Draw a single clip frame, baking the facing flip into the canvas.
function drawClipFrame() {
  const img = images[state.clipName][state.frame];
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

// Draw the REST pose: gaze-selected eyes frame, with a soft cross-fade when the
// gaze frame changes, all under the breathing scale. Bodies are pixel-identical
// across eyes frames, so only the pupils visibly fade.
function drawRest(now) {
  const eyes = images.eyes;
  if (!eyes || eyes.length === 0) return;

  // Pick the target gaze frame and start a fade if it changed.
  const want = gazeFrameIndex();
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
    ctx.drawImage(prevImg, 0, 0, SRC, SRC, 0, 0, WIN, WIN);
  }
  if (curImg && curImg.complete && curImg.naturalWidth) {
    ctx.globalAlpha = Math.min(gaze.t, 1);
    ctx.drawImage(curImg, 0, 0, SRC, SRC, 0, 0, WIN, WIN);
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

// Draw the status / drop glyphs as an OVERLAY, after the click-through hit-test
// has already sampled the (glyph-free) dog. Keeping glyphs out of the hit-test
// means the small emoji floating by the dog's head never become draggable nor
// disturb click-through. Position is screen-stable (top-right of the dog).
function drawOverlay(now) {
  // Status glyph: working ⚙️ / waiting ❗ persist; done ✅ only until glyphUntil.
  let glyph = null;
  if (claude.status === 'working' || claude.status === 'waiting') {
    glyph = CLAUDE_GLYPH[claude.status];
  } else if (claude.status === 'done' && now < claude.glyphUntil) {
    glyph = CLAUDE_GLYPH.done;
  }
  if (glyph) {
    ctx.save();
    ctx.font = '22px system-ui, "Apple Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Top-right of the dog's head; fixed in canvas (window) space.
    ctx.fillText(glyph, WIN - 22, 24);
    ctx.restore();
  }

  // Drop-hover cue: a 📂 centered over the dog inviting the drop (section E).
  if (dropHover) {
    ctx.save();
    ctx.font = '40px system-ui, "Apple Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📂', WIN / 2, WIN / 2);
    ctx.restore();
  }
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

  // 2) Advance the current clip by elapsed time vs its fps (REST is gaze-driven,
  //    so it is skipped here and handled entirely in drawFrame/drawRest).
  if (!isResting()) advanceAnimation(dt);

  // 3) Move toward the walk target if we're walking.
  if (walkTarget) stepWalk(dt);

  // 4) Draw, then re-test click-through against the (possibly moved) sprite.
  drawFrame(now, dt);
  updateInteractivity();
  // 5) Glyph overlay last, so it never participates in the hit-test above.
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
    if (state.frame >= clip.frames) {
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
  setClip('eyes');
  scheduleActive();
}

function scheduleActive() {
  clearTimeout(state.phaseTimer);
  // Don't arm the scheduler while any Claude status owns the dog. working/
  // waiting hold indefinitely; 'done' holds until its clear timer calls
  // enterRest, so the post-bark REST shouldn't re-arm early.
  if (state.paused || state.dragging || claude.status !== 'idle') return;
  const delay = rand(REST_MIN, REST_MAX);
  state.phaseTimer = setTimeout(enterActive, delay);
}

// Begin an ACTIVE phase: run n=1 (60%) or 2 (40%) activities back-to-back.
function enterActive() {
  if (state.paused || state.dragging || claudeHolding()) return;
  state.activitiesLeft = Math.random() < 0.4 ? 2 : 1;
  runNextActivity();
}

// Start the next activity in the current ACTIVE phase.
function runNextActivity() {
  if (state.paused || state.dragging || claudeHolding()) return;
  const choice = pickActivity();
  if (choice === 'walk') {
    startWalk();
  } else {
    // scratch / bark / roll: play in place for 1–2 loops, then onActivityDone.
    setClip(choice, { loopTarget: Math.random() < 0.5 ? 1 : 2 });
  }
}

// One activity finished: run the next one, or fall back to REST when the burst
// is done.
function onActivityDone() {
  if (state.paused || state.dragging || claudeHolding()) return;
  state.activitiesLeft -= 1;
  if (state.activitiesLeft > 0) {
    runNextActivity();
  } else {
    enterRest();
  }
}

function startWalk() {
  // Re-query the work area each walk so display/resolution changes are honored.
  // getWorkArea is async; nothing else should drive the dog while we await it.
  window.pet.getWorkArea().then((wa) => {
    if (state.paused || state.dragging || claudeHolding()) return;

    // Bounds for the window top-left so the whole window stays on-screen.
    const minX = wa.x;
    const maxX = wa.x + wa.width - WIN;
    const minY = wa.y;
    const maxY = wa.y + wa.height - WIN;

    // Cap the burst length: ≤45% of work-area width horizontally, ≤30% of its
    // height vertically — short hops, not screen-crossing marches. Still clamped
    // fully on-screen.
    const dx = rand(-0.45, 0.45) * wa.width;
    const dy = rand(-0.3, 0.3) * wa.height;
    const tx = clamp(state.pos.x + dx, minX, maxX);
    const ty = clamp(state.pos.y + dy, minY, maxY);

    state.facingRight = tx > state.pos.x;
    walkTarget = { x: tx, y: ty };
    setClip('walk'); // looped; arrival at target ends it
  });
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

  // Pause the scheduler while held and keep the window interactive.
  clearTimeout(state.phaseTimer);
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

  if (state.paused) {
    // Paused: settle straight into REST, no scheduling.
    setClip('eyes');
    return;
  }

  // A Claude status was held off while the user dragged (drag always wins).
  // Re-project it now instead of resuming the autonomous scheduler.
  if (claudeHolding()) {
    setClip('eyes'); // attentive REST; scheduler stays paused
    return;
  }
  if (claude.status === 'done') {
    // The 'done' one-shot's clear timer already owns the resume; just settle.
    setClip('eyes');
    return;
  }

  if (!moved) {
    // A tap (petting): the dog yips once as a one-off activity, then REST.
    state.activitiesLeft = 1;
    setClip('bark', { loopTarget: 1 });
  } else {
    // A real drag: settle, then resume the rest/active cycle after a short beat.
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
  if (p) window.pet.openInClaude(p);
});

// ---- Menu commands from main ------------------------------------------------

window.pet.onMenuCommand((cmd) => {
  if (cmd === 'toggle-pause') {
    state.paused = !state.paused;
    if (state.paused) {
      // Force REST and stop the scheduler until resumed.
      clearTimeout(state.phaseTimer);
      clearTimeout(state.resumeTimer);
      walkTarget = null;
      setClip('eyes');
    } else {
      enterRest();
    }
  }
});

// Global cursor feed (screen points) → aim the resting gaze.
window.pet.onCursor((p) => {
  latestCursor = { x: p.x, y: p.y };
});

// ---- Claude Code status layer (section D) -----------------------------------
//
// Maps forwarded hook events to the dog's reaction. A live drag always wins, so
// holds never fight the user; we record the requested status but only project
// it onto the clip once the drag ends (endDrag re-applies it).

// Enter an attentive REST hold (working/waiting): pause the scheduler and sit
// with the gaze-tracked eyes. No-op visually if a drag is in progress.
function enterClaudeHold() {
  clearTimeout(state.phaseTimer);
  clearTimeout(state.resumeTimer);
  clearTimeout(claude.clearTimer);
  claude.clearTimer = null;
  walkTarget = null;
  if (!state.dragging) setClip('eyes'); // attentive REST; eyes track cursor
}

// Fire the 'done' one-shot: a happy yip + ✅ glyph, then (after CLEAR_MS) clear
// the status and hand control back to the scheduler. Takes precedence over any
// working/waiting hold.
function fireClaudeDone() {
  claude.status = 'done';
  claude.glyphUntil = performance.now() + CLAUDE_DONE_GLYPH_MS;
  clearTimeout(state.phaseTimer);
  clearTimeout(state.resumeTimer);
  clearTimeout(claude.clearTimer);
  walkTarget = null;
  // Play one happy bark, unless the user is mid-drag (drag wins — we still flip
  // status, and endDrag won't override 'done').
  if (!state.dragging && !state.paused) {
    state.activitiesLeft = 1; // a single celebratory yip, then back to REST
    setClip('bark', { loopTarget: 1 });
  }
  claude.clearTimer = setTimeout(() => {
    claude.status = 'idle';
    claude.clearTimer = null;
    // Resume the autonomous scheduler from REST (unless paused/dragging).
    if (!state.paused && !state.dragging) enterRest();
  }, CLAUDE_DONE_CLEAR_MS);
}

window.pet.onClaudeEvent(({ event }) => {
  switch (event) {
    case 'UserPromptSubmit':
      claude.status = 'working';
      enterClaudeHold();
      break;
    case 'Notification':
      claude.status = 'waiting';
      enterClaudeHold();
      break;
    case 'Stop':
      fireClaudeDone();
      break;
    case 'SubagentStop':
    default:
      // Ignore SubagentStop (and anything unrecognized) to avoid noise.
      break;
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
  // window's top-left. Also seed the gaze cursor (screen points) directly.
  try {
    const c = await window.pet.getCursor();
    lastCursor = { x: c.x - wx, y: c.y - wy };
    latestCursor = { x: c.x, y: c.y };
  } catch (_) {
    /* fall back to the -1 sentinels; pointermove / onCursor will populate them */
  }

  // Begin in REST and start the render loop.
  enterRest();
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

start();
