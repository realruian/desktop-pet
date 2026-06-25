// settings.js — 设置面板渲染层。只做表单装填、保存、状态反馈。
// 真正的读写都在主进程（preload-settings 桥过去），渲染层不碰文件系统。

const $ = (id) => document.getElementById(id);
const els = {
  apiKey: $('apiKey'),
  toggleKey: $('toggleKey'),
  model: $('model'),
  baseURL: $('baseURL'),
  vault: $('vault'),
  pickVault: $('pickVault'),
  openFile: $('openFile'),
  save: $('save'),
  close: $('close'),
  status: $('status'),
  welcome: $('welcome'),
};

// 跟主进程的 looksLikeRealKey 同义：决定"欢迎横幅是否要显示"
// 以及"Key 字段算不算填好了"。
function looksLikeRealKey(k) {
  if (typeof k !== 'string') return false;
  const s = k.trim();
  return s.length >= 15 && s.startsWith('sk-');
}

let statusTimer = null;
function flash(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
  clearTimeout(statusTimer);
  if (!isError) {
    statusTimer = setTimeout(() => {
      els.status.textContent = '';
    }, 1800);
  }
}

// 进入面板时拉一次当前配置铺到表单里
async function refill() {
  try {
    const cfg = await window.settings.load();
    els.apiKey.value = cfg.apiKey || '';
    els.model.value = cfg.model || '';
    els.baseURL.value = cfg.baseURL || '';
    els.vault.value = cfg.vault || '';
    // 没填真 Key 就让欢迎横幅出来；填好了就藏起来不打扰
    els.welcome.hidden = looksLikeRealKey(cfg.apiKey);
  } catch (err) {
    flash('读取失败：' + err.message, true);
  }
}
refill();
// 设置窗每次被显示都重新拉，避免外部改过文件之后表单还是旧的
window.settings.onShown(refill);

els.close.addEventListener('click', () => window.settings.hide());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.settings.hide();
  // ⌘/Ctrl + S 触发保存
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    els.save.click();
  }
});

// 显示/隐藏 Key 的小眼睛
els.toggleKey.addEventListener('click', () => {
  const showing = els.apiKey.type === 'text';
  els.apiKey.type = showing ? 'password' : 'text';
  els.toggleKey.textContent = showing ? '👁' : '🙈';
});

// "选文件夹"按钮 → 主进程弹原生目录选择器
els.pickVault.addEventListener('click', async () => {
  const picked = await window.settings.pickVault();
  if (picked) els.vault.value = picked;
});

// "高级"按钮 → 用系统编辑器打开 config.json
els.openFile.addEventListener('click', () => window.settings.openFile());

els.save.addEventListener('click', async () => {
  const payload = {
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    baseURL: els.baseURL.value.trim(),
    vault: els.vault.value.trim(),
  };
  if (!payload.apiKey) {
    flash('API Key 不能为空', true);
    els.apiKey.focus();
    return;
  }
  els.save.disabled = true;
  try {
    const res = await window.settings.save(payload);
    if (res && res.ok) {
      flash('已保存 ✓');
    } else {
      flash('保存失败：' + (res && res.error) || '未知错误', true);
    }
  } catch (err) {
    flash('保存失败：' + err.message, true);
  } finally {
    els.save.disabled = false;
  }
});
