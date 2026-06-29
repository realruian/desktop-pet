const assert = require('assert');
const test = require('node:test');
const { buildChatCompletionsBody } = require('../lib/chat-request');

test('OpenRouter requests include web plugin', () => {
  const body = buildChatCompletionsBody({
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'x',
    messages: [],
    temperature: 0.6,
    maxTokens: 10,
  });
  assert.deepEqual(body.plugins, [{ id: 'web' }]);
});

test('non-OpenRouter requests omit provider-specific plugin field', () => {
  const body = buildChatCompletionsBody({
    baseURL: 'https://aihubmix.com/v1',
    model: 'x',
    messages: [],
    temperature: 0.6,
    maxTokens: 10,
  });
  assert.equal(Object.hasOwn(body, 'plugins'), false);
});
