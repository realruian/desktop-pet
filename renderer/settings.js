// settings.js — 设置面板渲染层。表单装填、服务商预设、模型拉取、人设、
// 唤醒开关、测试连接、保存。真正读写都在主进程（preload-settings 桥过去）。

const $ = (id) => document.getElementById(id);
const els = {
  apiKey: $('apiKey'),
  toggleKey: $('toggleKey'),
  model: $('model'),
  modelList: $('modelList'),
  modelHint: $('modelHint'),
  refreshModels: $('refreshModels'),
  baseURL: $('baseURL'),
  presetOpenRouter: $('presetOpenRouter'),
  presetAiHubMix: $('presetAiHubMix'),
  persona: $('persona'),
  resetPersona: $('resetPersona'),
  vault: $('vault'),
  pickVault: $('pickVault'),
  wakeEnabled: $('wakeEnabled'),
  wakeThreshold: $('wakeThreshold'),
  wakeLabel: $('wakeLabel'),
  openFile: $('openFile'),
  test: $('test'),
  save: $('save'),
  close: $('close'),
  status: $('status'),
  welcome: $('welcome'),
};

// 两个服务商的接口地址；模型 ID 在两家通用，所以切换不动 model。
const PRESETS = {
  openrouter: 'https://openrouter.ai/api/v1',
  aihubmix: 'https://aihubmix.com/v1',
};

// 内置默认人设（load 时由主进程带回，给「恢复默认」用）。
let defaultPersona = '';

// 跟主进程的 looksLikeRealKey 同义：只挡空/极短串，不强制 sk- 前缀。
function looksLikeRealKey(k) {
  return typeof k === 'string' && k.trim().length >= 15;
}

// innerHTML 注入 <option> 前转义，杜绝模型名里的特殊字符破坏标签。
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]
  );
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

// 当前表单收集成 patch，给保存 / 测试 / 拉模型共用。
function currentPatch() {
  return {
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    baseURL: els.baseURL.value.trim(),
    persona: els.persona.value,
    vault: els.vault.value.trim(),
    wakeEnabled: els.wakeEnabled.checked,
    wakeThreshold: parseFloat(els.wakeThreshold.value) || 0.2,
  };
}

// 接口地址匹配哪个预设就高亮哪个按钮。
function syncPresetActive() {
  const b = els.baseURL.value.trim();
  els.presetOpenRouter.classList.toggle('active', b.includes('openrouter.ai'));
  els.presetAiHubMix.classList.toggle('active', b.includes('aihubmix.com'));
}

// 唤醒开关旁的「开启/关闭」文字跟着 checkbox 走。
function updateWakeLabel() {
  els.wakeLabel.textContent = els.wakeEnabled.checked ? '开启' : '关闭';
}

// 进入面板时拉一次当前配置铺到表单里
async function refill() {
  try {
    const cfg = await window.settings.load();
    els.apiKey.value = cfg.apiKey || '';
    els.model.value = cfg.model || '';
    els.baseURL.value = cfg.baseURL || '';
    els.vault.value = cfg.vault || '';
    els.persona.value = cfg.persona || '';
    defaultPersona = cfg.defaultPersona || '';
    els.wakeEnabled.checked = !!cfg.wakeEnabled;
    els.wakeThreshold.value =
      cfg.wakeThreshold != null ? cfg.wakeThreshold : 0.2;
    updateWakeLabel();
    syncPresetActive();
    // 没填真 Key 就让欢迎横幅出来；填好了就藏起来不打扰
    els.welcome.hidden = looksLikeRealKey(cfg.apiKey);
  } catch (err) {
    flash('读取失败：' + err.message, true);
  }
}
refill();
// 设置窗每次被显示都重新拉，避免外部改过文件之后表单还是旧的
window.settings.onShown(refill);

// ---- 服务商预设：一键填接口地址 ----
els.presetOpenRouter.addEventListener('click', () => {
  els.baseURL.value = PRESETS.openrouter;
  syncPresetActive();
});
els.presetAiHubMix.addEventListener('click', () => {
  els.baseURL.value = PRESETS.aihubmix;
  syncPresetActive();
});
els.baseURL.addEventListener('input', syncPresetActive);

// ---- 模型：拉取该服务商的真实可用列表，填进可搜索下拉 ----
els.refreshModels.addEventListener('click', async () => {
  els.refreshModels.disabled = true;
  els.modelHint.textContent = '拉取中…';
  try {
    const r = await window.settings.listModels(currentPatch());
    if (r && r.ok) {
      els.modelList.innerHTML = r.models
        .map((id) => `<option value="${escapeHtml(id)}"></option>`)
        .join('');
      els.modelHint.textContent =
        '已拉取 ' + r.models.length + ' 个模型——点模型框搜索选择';
    } else {
      els.modelHint.textContent = '拉取失败：' + ((r && r.error) || '未知');
    }
  } catch (err) {
    els.modelHint.textContent = '拉取失败：' + err.message;
  } finally {
    els.refreshModels.disabled = false;
  }
});

// ---- 人设「恢复默认」----
els.resetPersona.addEventListener('click', () => {
  els.persona.value = defaultPersona;
  els.persona.focus();
});

// ---- 语音唤醒开关：联动文字 ----
els.wakeEnabled.addEventListener('change', updateWakeLabel);

// ---- 显示/隐藏 Key 的小眼睛：两个 IconPark 线性图标，跟随 currentColor。
// 含 ASCII 双引号，整串用 backtick 包，避免被当字符串结束符。
const EYE_SVG = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24 12C13 12 5 24 5 24C5 24 13 36 24 36C35 36 43 24 43 24C43 24 35 12 24 12Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><circle cx="24" cy="24" r="6" stroke="currentColor" stroke-width="4"/></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M6 14C6 14 14 24 24 24C34 24 42 14 42 14" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 24V32" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M34 21L39 28" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M14 21L9 28" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`;
els.toggleKey.addEventListener('click', () => {
  const showing = els.apiKey.type === 'text';
  els.apiKey.type = showing ? 'password' : 'text';
  // 切回隐藏(password)→显示"可看"眼睛；切到明文(text)→显示"隐藏"图标
  els.toggleKey.innerHTML = showing ? EYE_SVG : EYE_OFF_SVG;
});

// ---- 选文件夹 / 高级（打开 config.json）----
els.pickVault.addEventListener('click', async () => {
  const picked = await window.settings.pickVault();
  if (picked) els.vault.value = picked;
});
els.openFile.addEventListener('click', () => window.settings.openFile());

// ---- 测试连接：用当前表单发个极小请求验证通不通 ----
els.test.addEventListener('click', async () => {
  els.test.disabled = true;
  flash('测试中…');
  try {
    const r = await window.settings.test(currentPatch());
    if (r && r.ok) flash('连接正常');
    else flash('测试失败：' + ((r && r.error) || '未知'), true);
  } catch (err) {
    flash('测试失败：' + err.message, true);
  } finally {
    els.test.disabled = false;
  }
});

// ---- 保存 ----
els.save.addEventListener('click', async () => {
  const payload = currentPatch();
  if (!payload.apiKey) {
    flash('API Key 不能为空', true);
    els.apiKey.focus();
    return;
  }
  els.save.disabled = true;
  try {
    const res = await window.settings.save(payload);
    if (res && res.ok) {
      flash('已保存');
      els.welcome.hidden = looksLikeRealKey(payload.apiKey);
    } else {
      flash('保存失败：' + ((res && res.error) || '未知错误'), true);
    }
  } catch (err) {
    flash('保存失败：' + err.message, true);
  } finally {
    els.save.disabled = false;
  }
});

// ---- 键盘：Esc 关闭，⌘/Ctrl+S 保存 ----
els.close.addEventListener('click', () => window.settings.hide());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.settings.hide();
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    els.save.click();
  }
});
