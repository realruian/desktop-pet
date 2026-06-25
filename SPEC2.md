# Hema Desktop Pet — Upgrade Spec (v2)

Builds on the shipped v1 (see `SPEC.md`, `main.js`, `preload.js`, `renderer/*`). Four additions:
1. **Rest ~50% of the time, with breathing** (less constant motion).
2. **Eyes follow the mouse** while resting (new `assets/eyes/01..09.png`).
3. **Drop a file/folder on the pet → open Terminal.app running Claude Code** there.
4. **Live Claude Code status** via this project's hooks → pet reflects working/waiting/done.

Keep all v1 invariants: transparent/frameless/always-on-top, pixel-perfect click-through,
manual 1:1 drag, secure config (contextIsolation on / nodeIntegration off), flip baked into
canvas, uniform 420→WIN draw with shared baseline (no pose jumps).

---

## A. Behavior model v2 (rewrite the scheduler in `renderer/pet.js`)

New canonical idle is **REST** (replaces the old plain `scratch[0]` idle):
- **REST**: pet sits using the **eyes frames** (gaze tracks the cursor, section B) **plus
  breathing** (section C). This is where the pet spends ~half its time.
- **WALK / scratch / wave / roll**: unchanged clips, but driven by the new phase scheduler.
- **DRAG**: unchanged.

**Phase scheduler (target ≈50% rest, in meaningful stretches):**
- Enter **REST phase** for `rand(REST_MIN, REST_MAX)` ms (`REST_MIN=6000, REST_MAX=12000`).
- Then an **ACTIVE phase**: perform `n` activities back-to-back, `n = Math.random()<0.4 ? 2 : 1`.
  Each activity = weighted pick `walk 45 / scratch 18 / wave 18 / roll 19`.
- After the active phase's activities finish → back to REST phase. Repeat.
- **Walk targets are capped** so bursts stay short: `|tx-pos.x| ≤ 0.45*wa.width`,
  `|ty-pos.y| ≤ 0.30*wa.height` (still clamped fully on-screen). Speed unchanged (~150px/s).
- Menu "暂停走动" → force REST, stop the scheduler until resumed.
- The Claude status (section D) can override: while WORKING/WAITING the scheduler is paused and
  the pet stays in an attentive REST (eyes still track the cursor).

## B. Eyes follow mouse (`assets/eyes/01..09.png`, already prepared)

9 front-facing gaze frames; body is pixel-identical, only pupils move. **Gaze map** (already
derived): frame 01 = looking **East/right**, even ~40° steps around the circle:
`frameIndex0 = ((Math.round(angleDeg / 40) % 9) + 9) % 9`  (0-based; file = `eyes/0{idx+1}.png`)
where `angleDeg` is the screen direction from the pet to the cursor, **up = positive**:
`angleDeg = (atan2(-(cursorY - centerY), cursorX - centerX) * 180/PI + 360) % 360`,
`centerX = pos.x + WIN/2`, `centerY = pos.y + WIN/2` (screen points).

- **Main** (`main.js`): poll `screen.getCursorScreenPoint()` every 33ms; `webContents.send('cursor', {x,y})`
  (skip sends when unchanged). Start after window load; clear on close.
- **preload**: `onCursor(cb)` → `ipcRenderer.on('cursor', (_,p)=>cb(p))`.
- **Renderer**: store `latestCursor` (screen pts). Eyes are used **only during REST** (and during
  Claude WORKING/WAITING attentive rest). Recompute `frameIndex0` each render frame from
  `latestCursor` + current `state.pos`.
- **Soft fade on gaze change** (the original ask): keep `gaze.prev`, `gaze.cur`, `gaze.t`. When the
  computed index differs from `gaze.cur`, set `prev=cur`, `cur=new`, `t=0`. Each frame advance
  `t += dt/0.12` (≈120ms). Draw `eyes[prev]` then `eyes[cur]` with `globalAlpha = min(t,1)`.
  Bodies are identical so only the pupils cross-fade. When not resting, no eye drawing.

## C. Breathing (subtle, during REST)

In the render path, when resting, wrap the draw in a vertical scale anchored at the ground baseline
so the feet stay planted and the chest rises:
- `s = 1 + BREATH_AMT * Math.sin(2*PI * tNow / BREATH_PERIOD)`, `BREATH_AMT=0.02`, `BREATH_PERIOD=3200`ms.
- `const by = 388 * (WIN/420)` (baseline in canvas px). `ctx.translate(cx, by); ctx.scale(1, s); ctx.translate(-cx, -by);` (cx = WIN/2), then draw the (gaze) frame. Apply breathing only in REST.

## D. Claude Code status integration (this project only)

**Transport:** `main.js` starts a loopback HTTP server `127.0.0.1:4319` (const `CLAUDE_PORT`). On
`POST /hook` it reads the JSON body (Claude Code hook payload), takes `hook_event_name`, and:
- updates `claudeStatus`, `webContents.send('claude-event', {event, cwd})` to the renderer,
- shows a native `Notification` on completion.
- If the port is taken / any error: log once and continue — the pet must still work without it.

**Hook config** (the orchestrator writes `.claude/settings.json`, do NOT clobber existing keys):
each of `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop` forwards stdin to the pet:
`curl -s -m 1 -X POST http://127.0.0.1:4319/hook -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true`

**Event → status → pet reaction** (renderer):
- `UserPromptSubmit` → **WORKING**: pause scheduler, attentive REST, draw a small ⚙️ glyph (top-right of pet).
- `Notification` → **WAITING**: attentive REST, draw ❗ glyph; (optional gentle native notification "Claude 在等你").
- `Stop` → **DONE**: play `wave` once (a happy yip), draw ✅ glyph for ~1.5s, fire native
  `Notification{title:'✅ 任务完成', body: project basename of cwd}`; after ~4s clear status → resume scheduler.
- `SubagentStop` → ignore (avoid noise).
- Status glyphs: `ctx.fillText` emoji at ~22px near the pet's head; subtle. Clear when status returns to idle.
- Precedence: DONE one-shot wave > WORKING/WAITING attentive hold > autonomous scheduler.

**Notes:** hooks live in THIS project, so they also fire for the Claude Code session building this —
that's fine and is a live self-test. Connection-refused returns instantly (no latency) when the pet is down.

## E. Drop a file/folder → Terminal + Claude Code

**Renderer** (`pet.js`): globally `preventDefault` on `dragover`/`drop` (so the window never navigates).
On the canvas: `dragover` → `e.preventDefault(); e.dataTransfer.dropEffect='copy'`; set `dropHover=true`
(show a 📂 glyph + tiny scale-up cue). `dragleave`/`drop` → `dropHover=false`. On `drop`: take
`e.dataTransfer.files[0]`, get its path via `window.pet.getPathForFile(file)`, then
`window.pet.openInClaude(path)`. (Dropping onto the opaque body works because hovering the body has
already turned click-through off.)

**preload**: `const {webUtils}=require('electron');` expose `getPathForFile:(f)=>webUtils.getPathForFile(f)`
and `openInClaude:(p)=>ipcRenderer.send('open-in-claude', p)`.

**main** (`ipcMain.on('open-in-claude', (_e, p))`): `fs.statSync(p)`; if directory → `dir=p`, else
`dir=path.dirname(p)`, `file=path.basename(p)`. Launch via `execFile('osascript', ['-e', applescript])`:
```
tell application "Terminal"
  activate
  do script "cd " & <shell-quoted dir> & " && claude"
end tell
```
Build the AppleScript string in JS; shell-quote the dir (wrap in single quotes, escape `'`), and
escape `"`/`\` for the AppleScript string literal. If it was a **file**, best-effort prefill (no send):
a second `osascript` after a short delay → `tell application "System Events" to keystroke "@<file> "`
(escape `"`/`\`; needs Accessibility permission — wrap in try/ignore so failure doesn't break the open).
Do not send Return. Errors must be caught and logged, never crash the pet.

---

## Self-test (implementing agent)
1. `node --check` every JS file you touch.
2. Smoke-launch: `npx electron . > /tmp/pet_v2.log 2>&1 &`, wait ~4s, assert process alive and the
   log has no uncaught exceptions / "Error" / "Cannot find". Kill it. Report the log verbatim.
3. For the HTTP listener (section D): with the app running, `curl -s -m1 -XPOST 127.0.0.1:4319/hook
   -H 'content-type: application/json' -d '{"hook_event_name":"Stop","cwd":"/tmp/demo"}'` must return
   without error and the main log should show it handled the event (add a concise `console.log`).
4. For section E: you cannot drive a real Finder drag. Instead temporarily exercise the main handler
   by sending a known path through the same IPC path is not possible headlessly; at minimum verify the
   AppleScript string is built correctly (log it under an env flag) and `node --check` passes. Note this
   limitation in your report. Do NOT actually spawn Terminal during the smoke test.
Leave NO electron process running when done.
