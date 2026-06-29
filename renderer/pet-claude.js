(function exposePetClaude(root) {
  function taskLabelFrom(prompt, cwd) {
    const parts = (cwd || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : 'Claude';
  }

  function deriveDisplay(sessions, staleMs, wall = Date.now()) {
    for (const [sid, s] of sessions) {
      if (wall - s.last > staleMs) sessions.delete(sid);
    }
    const all = [...sessions.values()];
    const waiting = all.filter((s) => s.status === 'waiting');
    const working = all.filter((s) => s.status === 'working');
    if (waiting.length) {
      return {
        display: 'waiting',
        taskLabel: waiting[waiting.length - 1].label,
        taskExtra: all.length - 1,
      };
    }
    if (working.length) {
      working.sort((a, b) => a.last - b.last);
      return {
        display: 'working',
        taskLabel: working[working.length - 1].label,
        taskExtra: working.length - 1,
      };
    }
    return { display: 'idle', taskLabel: '', taskExtra: 0 };
  }

  root.PetClaude = { taskLabelFrom, deriveDisplay };
})(window);
