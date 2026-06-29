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
const clearEl = document.getElementById('clear');

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
  div.className = 'msg pet typing';
  div.innerHTML = '<i></i><i></i><i></i>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// 欢迎气泡 + 输入框文案都随当前角色名变化。petName 由 getCharacter() 填真名，
// '桌宠' 只是 IPC 返回前的首帧兜底。初始欢迎气泡在文件末尾的启动块里发出。
let petName = '桌宠';
const greetingText = () => `我是${petName}，跟我说点什么吧～`;

// 清空对话：清掉历史和气泡，重新放一句欢迎，回到刚开聊的状态。
// 不弹确认——会话内是临时聊天、关掉聊天窗也不持久化，不是高风险操作。
function clearConversation() {
  history.length = 0;
  messagesEl.innerHTML = '';
  addBubble('pet', greetingText());
  inputEl.focus();
}
clearEl.addEventListener('click', clearConversation);

// 发送一条消息：从输入框读取并发出。
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || sending) return;
  inputEl.value = '';
  autosize();

  addBubble('user', text);
  history.push({ role: 'user', content: text });
  window.chat.reportUserMessage();

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
    addBubble('pet', res.content.replace(/\*\*(.+?)\*\*/g, '$1'));
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

const placeholderIdle = () => `跟${petName}说点什么…`;

sendEl.addEventListener('click', () => sendMessage());
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

// 聊天窗是「创建一次、反复隐藏/显示」，每次 openChat 主进程都会 chatWin.focus()，
// 触发这里的 window focus 事件 → 把焦点落到输入框，双击打开即可直接打字，无需再点一下。
// 每次聊天窗获得焦点（= 每次打开）：聚焦输入框，并校准角色名——切换角色后若
// 名字变了就刷新标题/占位，对话还空着时连欢迎气泡一起换成新角色名（双保险，
// 兜住 character-name 推送可能错过的时序）。
window.addEventListener('focus', () => {
  inputEl.focus();
  window.chat
    .getCharacter()
    .then((ch) => {
      if (ch && ch.name && ch.name !== petName) {
        petName = ch.name;
        applyPetName();
        refreshGreetingIfEmpty();
      }
    })
    .catch(() => {});
});

inputEl.focus();

// ---- 角色名注入：标题/占位/欢迎都随当前角色名 ------------------------------
function applyPetName() {
  const t = document.getElementById('title');
  if (t) t.textContent = `和${petName}聊天`;
  document.title = `${petName}聊天`;
  inputEl.placeholder = placeholderIdle();
}

// 对话还空着（只有欢迎气泡、没真实问答）时，把欢迎气泡也换成当前角色名。
function refreshGreetingIfEmpty() {
  if (history.length > 0) return;
  messagesEl.innerHTML = '';
  addBubble('pet', greetingText());
}

// 拉一次当前角色名，铺好文案，再发首条欢迎气泡（用真名）。
window.chat
  .getCharacter()
  .then((ch) => {
    if (ch && ch.name) petName = ch.name;
  })
  .catch(() => {
    /* 拿不到就用兜底名 */
  })
  .finally(() => {
    applyPetName();
    addBubble('pet', greetingText());
  });

// 右键菜单切换角色后，主进程推来新名字 → 刷新标题/占位；对话还空着时连欢迎
// 气泡一起换成新角色名（聊过了就只动标题，不改历史对话）。
window.chat.onCharacterName((name) => {
  if (!name) return;
  petName = name;
  applyPetName();
  refreshGreetingIfEmpty();
});
