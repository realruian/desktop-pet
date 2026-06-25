# Hema Desktop Pet — Implementation Spec

A macOS Electron desktop pet: a pixel-art hema that sits, **wanders randomly**, and is
**draggable**. The window is transparent, frameless, always-on-top, and click-through
everywhere **except** the pet's body (pixel-perfect).

## Assets (already prepared — do NOT regenerate)
All normalized to a **420×420** canvas, pet grounded at baseline **y=388**, same pixel scale:
- `assets/walk/01.png … 09.png` — walking, **art faces LEFT** (side profile)
- `assets/scratch/01.png … 09.png` — sitting/scratching, faces front. `scratch/01.png` = idle resting pose
- `assets/wave/01.png … 09.png` — waving, faces front
- `assets/roll/01.png … 09.png` — rolling on back, on the floor

## Files to create
- `main.js` — Electron main process
- `preload.js` — secure IPC bridge (contextIsolation)
- `renderer/index.html`
- `renderer/style.css`
- `renderer/pet.js` — animation + behavior state machine

## Constants
- `WIN = 200` — window is `WIN×WIN` (square). Canvas drawn at this size.
- Source frames are 420px; draw scaled to `WIN` with smoothing OFF (crisp pixel art).
- Walk speed ≈ `150` px/s. Idle pause between behaviors: random `2500–6000` ms.
- Frame rates: walk 10 fps, scratch 8 fps, wave 9 fps, roll 8 fps.
- Behavior pick weights from IDLE: walk 55, scratch 15, wave 15, roll 15.

## main.js
- `BrowserWindow`: `width:WIN, height:WIN, transparent:true, frame:false, resizable:false,`
  `movable:true, hasShadow:false, skipTaskbar:true, fullscreenable:false, useContentSize:true,`
  `webPreferences:{ preload, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false }`.
- After create: `win.setAlwaysOnTop(true, 'floating')`,
  `win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen:true })`,
  `win.setIgnoreMouseEvents(true, { forward:true })` (start click-through; forward keeps mousemove).
- Initial position: bottom-right of `screen.getPrimaryDisplay().workArea`
  (`x = wa.x + wa.width - WIN - 40`, `y = wa.y + wa.height - WIN - 30`).
- On macOS hide dock icon: `app.dock?.hide()`. Quit when all windows closed.
- IPC handlers:
  - `ipcMain.on('set-ignore', (e, ignore) => win.setIgnoreMouseEvents(ignore, { forward:true }))`
  - `ipcMain.on('move-to', (e, {x,y}) => win.setPosition(Math.round(x), Math.round(y)))`
  - `ipcMain.handle('get-pos', () => win.getPosition())` → `[x,y]`
  - `ipcMain.handle('get-cursor', () => screen.getCursorScreenPoint())` → `{x,y}`
  - `ipcMain.handle('get-work-area', () => screen.getDisplayMatching(win.getBounds()).workArea)`
  - `ipcMain.on('show-menu', ...)` → build a `Menu` and `popup()`:
    - "暂停 / 继续走动" → toggles; send `win.webContents.send('menu-command','toggle-pause')`
    - separator
    - "退出" → `app.quit()`
  - `ipcMain.on('quit', () => app.quit())`

## preload.js
Expose `window.pet` via `contextBridge`:
```
setIgnore(ignore)            -> ipcRenderer.send('set-ignore', ignore)
moveTo(x, y)                 -> ipcRenderer.send('move-to', {x, y})
getPos()                     -> ipcRenderer.invoke('get-pos')        // [x,y]
getCursor()                  -> ipcRenderer.invoke('get-cursor')     // {x,y}
getWorkArea()                -> ipcRenderer.invoke('get-work-area')  // {x,y,width,height}
showMenu()                   -> ipcRenderer.send('show-menu')
onMenuCommand(cb)            -> ipcRenderer.on('menu-command', (_,c)=>cb(c))
quit()                       -> ipcRenderer.send('quit')
```

## index.html / style.css
- Single `<canvas id="stage">` filling the window. Load `pet.js` as a module/script at end of body.
- CSS: `html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;}`
  `*{user-select:none;-webkit-user-select:none;-webkit-user-drag:none;}`
  `#stage{width:100vw;height:100vh;display:block;image-rendering:pixelated;}`
  No `-webkit-app-region` (we do manual dragging).

## pet.js — rendering
- Preload all frames into `Image` objects grouped by animation. Wait for all to load before starting.
- Canvas internal resolution = `WIN×WIN` (optionally ×devicePixelRatio for crispness; if so scale ctx).
  `ctx.imageSmoothingEnabled = false`.
- **Facing**: art faces LEFT. To face RIGHT, draw flipped horizontally **inside the canvas**
  (`ctx.translate(WIN,0); ctx.scale(-1,1)`) — do NOT use a CSS transform (hit-test must match pixels).
- Render loop with `requestAnimationFrame`: advance the current clip's frame by elapsed time vs its fps.
  Draw current frame scaled from 420→WIN, applying current facing flip.
- After drawing each frame, re-run the hover hit-test using the **last known cursor position**
  (so click-through toggles correctly as the pet animates/moves under a stationary cursor).

## pet.js — click-through hit test (pixel-perfect)
- Track `lastCursor` from `pointermove` (clientX/clientY relative to canvas rect).
- `isOverBody(cx, cy)`: map client coords → canvas internal px (account for rect scale & DPR),
  read `ctx.getImageData(px, py, 1, 1).data[3]`; return `alpha > 30`.
  (Because the flip is baked into the canvas, sampled pixels already match what's visible.)
- On every `pointermove` (these are forwarded even while ignoring): update `lastCursor`,
  compute `over = isOverBody(...)`. If `!dragging`: if `over !== currentlyInteractive` →
  `pet.setIgnore(!over)` and update `currentlyInteractive`. (Debounce: only call on change.)
- Re-evaluate the same toggle each animation frame using `lastCursor` (pet may move under cursor).

## pet.js — dragging (manual, main moves the window)
- Use Pointer Events on `window`/canvas.
- `pointerdown` when `isOverBody`: `canvas.setPointerCapture(e.pointerId)`; `dragging=true`;
  record `downScreen={x:e.screenX,y:e.screenY}`, `moved=false`; pause behavior;
  compute grab offset: `const [wx,wy] = await pet.getPos(); grab={x:e.screenX-wx, y:e.screenY-wy}`.
  While dragging keep `setIgnore(false)` (don't toggle on hover).
- `pointermove` while dragging: `moved = moved || dist(downScreen, {screenX,screenY}) > 4`.
  Throttle window moves with rAF: store `pending = {x:e.screenX-grab.x, y:e.screenY-grab.y}`;
  in the render loop, if `pending` → `pet.moveTo(pending.x,pending.y)`, update local `pos`, clear.
  (`screenX/screenY` are global screen coords in points = same space as `win.setPosition`.)
- `pointerup`: release capture; `dragging=false`; sync `pos = await pet.getPos()`.
  If `!moved` → it was a **tap**: play `wave` once (pet yips when petted), then idle.
  Else resume normal behavior after ~600ms (return to IDLE).

## pet.js — behavior state machine
Local state: `pos {x,y}` (window top-left, in screen points), `facingRight`, `paused`, `dragging`,
`current clip`, `behaviorTimer`.
- Init: `pos = await pet.getPos()`. Start in IDLE (show `scratch/01`). Schedule next behavior.
- **IDLE**: draw idle frame (`scratch[0]`). After random 2.5–6s pick next by weights:
  - **walk**: query `getWorkArea()`. Bounds for window top-left so it stays fully on-screen:
    `minX=wa.x, maxX=wa.x+wa.width-WIN, minY=wa.y, maxY=wa.y+wa.height-WIN`.
    Target: `tx = rand(minX,maxX)`; `ty = clamp(pos.y + rand(-0.18,0.18)*wa.height, minY, maxY)`
    (mostly-horizontal, slight vertical drift — looks natural for side-view walk).
    `facingRight = (tx > pos.x)`. Play walk clip looped; each rAF tick move `pos` toward target by
    `speed*dt` along the normalized vector; when within ~3px → snap to target → IDLE.
  - **scratch / wave / roll**: play that clip in place for 1–2 loops → IDLE.
- **paused** (menu toggle): force IDLE, no scheduling, until resumed.
- Re-query `getWorkArea()` at the start of each walk (handles display/resolution changes).

## Self-test (the implementing agent must run this before reporting done)
1. `npx electron . &` then wait ~3s. Capture **main-process stdout/stderr** — assert no
   uncaught exceptions / no "Error".
2. Verify the window exists and the process stays alive (doesn't crash within 5s).
3. Kill the test process. Report any console errors verbatim.
(Visual/behavioral acceptance is done by the orchestrator via screenshots — not your job.)

## Quality bar
- No vertical "jump" when switching poses (assets already share a baseline — keep draw anchoring uniform).
- Click-through must be pixel-accurate (transparent corners pass clicks through to apps below).
- Dragging must feel 1:1 with the cursor and not fight the wander AI.
- Secure Electron config (contextIsolation on, nodeIntegration off).
- Clean, commented code matching this spec's names.
