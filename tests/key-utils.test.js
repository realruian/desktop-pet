const assert = require('assert');
const test = require('node:test');
const { looksLikeRealKey, isOpenRouterBaseURL } = require('../shared/key-utils');

test('looksLikeRealKey rejects placeholders and prose', () => {
  assert.equal(looksLikeRealKey('你的 API Key：OpenRouter'), false);
  assert.equal(looksLikeRealKey('example-api-key-placeholder'), false);
  assert.equal(looksLikeRealKey('sk-valid-looking-token-123456'), true);
});

test('isOpenRouterBaseURL detects OpenRouter endpoints only', () => {
  assert.equal(isOpenRouterBaseURL('https://openrouter.ai/api/v1'), true);
  assert.equal(isOpenRouterBaseURL('https://foo.openrouter.ai/api/v1'), true);
  assert.equal(isOpenRouterBaseURL('https://aihubmix.com/v1'), false);
});
