// catcher.js — the invisible drop surface (section E).
//
// macOS stops delivering drag-destination events to a window once it has been
// click-through-configured (setIgnoreMouseEvents), even after the ignore is
// lifted — verified empirically: an identical transparent window that never
// ignored the mouse receives drags fine, the pet window never does. So the pet
// can't catch its own drops. Instead, main shows THIS window (never ignoring,
// 'floating' level — the exact recipe verified to receive drags) at the dog's
// bounds for the duration of any system drag. It relays hover state and the
// dropped path; the pet does the eating and the Terminal launch.

let hovering = false; // dragover fires continuously; only relay transitions

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  if (!hovering) {
    hovering = true;
    window.catcher.hover(true);
  }
});

window.addEventListener('dragleave', () => {
  hovering = false;
  window.catcher.hover(false);
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  hovering = false;
  window.catcher.hover(false);
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  const p = window.catcher.getPathForFile(f);
  if (p) window.catcher.drop(p);
});
