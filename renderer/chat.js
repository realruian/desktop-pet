// chat.js — the chat panel logic (section F).
//
// Keeps the conversation in memory (the window is hidden, not destroyed, on
// close — so history survives reopening within a session), renders bubbles,
// and round-trips messages to Kimi through the main process. The API key never
// enters this renderer.

'use strict';

// How much history to send per request (beyond the system persona, which main
// prepends). Trims old turns to keep requests bounded.
const HISTORY_LIMIT = 20;

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const closeEl = document.getElementById('close');

// Conversation history as Kimi messages: {role:'user'|'assistant', content}.
const history = [];

// One in-flight request at a time.
let sending = false;

function addBubble(cls, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'msg dog typing';
  div.innerHTML = '<i></i><i></i><i></i>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Local greeting (no API call) so the panel feels alive on first open.
addBubble('dog', '汪！我是你的桌面柯基🐶 有什么想聊的？');

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || sending) return;
  inputEl.value = '';
  autosize();

  addBubble('user', text);
  history.push({ role: 'user', content: text });

  sending = true;
  sendEl.disabled = true;
  const typing = addTyping();

  let res;
  try {
    res = await window.chat.send(history.slice(-HISTORY_LIMIT));
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }

  typing.remove();
  sending = false;
  sendEl.disabled = false;

  if (res && res.ok) {
    // The model occasionally slips in markdown bold; bubbles are plain text,
    // so strip the markers for display (history keeps the original).
    addBubble('dog', res.content.replace(/\*\*(.+?)\*\*/g, '$1'));
    history.push({ role: 'assistant', content: res.content });
  } else {
    // Errors render as a distinct bubble and are NOT added to history, so a
    // retry after fixing (e.g. filling in the API key) resends cleanly.
    addBubble('error', (res && res.error) || '出错了，再试一次？');
  }
  inputEl.focus();
}

// Grow the textarea with content (capped by CSS max-height).
function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = inputEl.scrollHeight + 'px';
}

sendEl.addEventListener('click', sendMessage);
inputEl.addEventListener('input', autosize);
inputEl.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter inserts a newline. Respect IME composition so
  // confirming Chinese candidates with Enter doesn't fire a send.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  } else if (e.key === 'Escape') {
    window.chat.hide();
  }
});

closeEl.addEventListener('click', () => window.chat.hide());

inputEl.focus();
