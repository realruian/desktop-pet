const { isOpenRouterBaseURL } = require('../shared/key-utils');

function buildChatCompletionsBody({ baseURL, model, messages, temperature, maxTokens }) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (isOpenRouterBaseURL(baseURL)) {
    body.plugins = [{ id: 'web' }];
  }
  return body;
}

module.exports = { buildChatCompletionsBody };
