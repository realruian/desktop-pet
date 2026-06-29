(function exposePetBond(root) {
  const STORAGE_KEY = 'hema.bond.v2';
  const SAVE_EVERY_MS = 3000;
  const EXPRESSION_HOLD_LOOPS = 2;
  const UNLOCKS = [
    { clip: 'tearful',  label: '泪眼婆娑', chatCount: 3  },
    { clip: 'tearful2', label: '委屈巴巴', chatCount: 10 },
    { clip: 'tearful3', label: '想贴贴',   taskCount: 5  },
    { clip: 'tearful4', label: '舍不得你', taskCount: 15 },
    { clip: 'cheer',    label: '美滋滋',   taskCount: 20 },
  ];

  function isExpressionClip(clip) {
    return UNLOCKS.some((e) => e.clip === clip);
  }

  function hydrateState(state, raw) {
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      state.chatCount = Math.max(0, Number(saved.chatCount) || 0);
      state.taskCount = Math.max(0, Number(saved.taskCount) || 0);
      const unlocked = Array.isArray(saved.unlocked) ? saved.unlocked : [];
      state.unlockedExpressions = new Set(
        unlocked.filter((clip) => isExpressionClip(clip))
      );
      for (const e of UNLOCKS) {
        const met = e.chatCount !== undefined
          ? state.chatCount >= e.chatCount
          : state.taskCount >= e.taskCount;
        if (met) state.unlockedExpressions.add(e.clip);
      }
    } catch (_) {
      state.chatCount = 0;
      state.taskCount = 0;
      state.unlockedExpressions = new Set();
    }
  }

  function serializeState(state) {
    return JSON.stringify({
      chatCount: state.chatCount,
      taskCount: state.taskCount,
      unlocked: [...state.unlockedExpressions],
    });
  }

  function summary(state) {
    return {
      chatCount: state.chatCount,
      taskCount: state.taskCount,
      unlocked: [...state.unlockedExpressions],
    };
  }

  function unlockedExpressionWeights(state, weight) {
    return UNLOCKS.filter((e) => state.unlockedExpressions.has(e.clip)).map((e) => ({
      name: e.clip,
      weight,
    }));
  }

  function findNewUnlock(state) {
    for (const e of UNLOCKS) {
      if (state.unlockedExpressions.has(e.clip)) continue;
      const met = e.chatCount !== undefined
        ? state.chatCount >= e.chatCount
        : state.taskCount >= e.taskCount;
      if (met) return e;
    }
    return null;
  }

  root.PetBond = {
    STORAGE_KEY,
    SAVE_EVERY_MS,
    EXPRESSION_HOLD_LOOPS,
    UNLOCKS,
    hydrateState,
    serializeState,
    summary,
    unlockedExpressionWeights,
    findNewUnlock,
    isExpressionClip,
  };
})(window);
