(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.KeyUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function createKeyUtils() {
  function looksLikeRealKey(k) {
    if (typeof k !== 'string') return false;
    const s = k.trim();
    if (s.length < 15) return false;
    if (/\s/.test(s)) return false;
    if (/[\u4e00-\u9fff]/.test(s)) return false;
    if (/你的|占位|示例|example|api\s*key/i.test(s)) return false;
    return true;
  }

  function isOpenRouterBaseURL(baseURL) {
    try {
      return new URL(baseURL).hostname.toLowerCase().endsWith('openrouter.ai');
    } catch (_) {
      return String(baseURL || '').toLowerCase().includes('openrouter.ai');
    }
  }

  return { looksLikeRealKey, isOpenRouterBaseURL };
});
