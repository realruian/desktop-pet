// preload-settings.js — 设置面板的 IPC 桥。
// 同样的最小暴露原则：contextIsolation 开着，渲染层只看到这几个方法。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  // 读取当前生效的配置（apiKey/model/baseURL/vault 四项），返回普通对象
  load: () => ipcRenderer.invoke('settings:load'),
  // 保存表单，返回 { ok: true } 或 { ok: false, error }
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  // 弹原生目录选择器，返回选中的路径或空串
  pickVault: () => ipcRenderer.invoke('settings:pick-vault'),
  // 用系统默认编辑器打开 config.json（高级入口）
  openFile: () => ipcRenderer.send('settings:open-file'),
  // 关闭/隐藏面板
  hide: () => ipcRenderer.send('settings:hide'),
  // 面板每次被显示时主进程会触发一次，让表单重新拉取一次配置
  onShown: (cb) => ipcRenderer.on('settings:shown', () => cb()),
});
