# 🐕 柯基桌宠 (Corgi Desktop Pet)

一只基于像素素材做的 Mac 桌面宠物：**固定待在一个地方**，安静休息（带呼吸感）、**眼睛跟随鼠标**、偶尔原地做个小动作，**可以拖动**；还能**接入 Claude Code 显示任务状态**，以及**把文件拖给它一键在终端启动 Claude Code**。窗口透明、无边框、永远置顶，空白处点击穿透到下面的应用。

![corgi](主图.png)

## 运行

```bash
npm install      # 安装依赖（Electron）
npm start        # 启动桌宠
```

启动后柯基会出现在屏幕**右下角**。退出：右键狗狗 → **退出**。

## 行为

| 交互 | 行为 |
| --- | --- |
| 😌 **安静休息（约 50%）** | 大部分时间坐着不动，有轻微**呼吸**起伏；眼睛**跟随你的鼠标**转动 |
| 🐾 **原地小动作** | 休息一阵后，做 1–2 个**原地**小动作：挠头 / 叫 / 躺下打滚，然后继续休息。默认**不会自己在桌面乱跑**（要移动它请直接拖）。想让它到处溜达，把 `pet.js` 顶部的 `WANDER` 改成 `true` |
| 🖱️ **拖动** | 按住身体拖到任意位置，1:1 跟手 |
| 👆 **轻点** | 在身上点一下（不拖），狗狗「汪」一声 |
| 🖱️➡️ **点击穿透** | 只有身体能点，透明区域穿透到下面的应用 |
| 🖱️ **右键** | 菜单：暂停/继续走动、退出 |

眼睛跟随：主进程每 ~33ms 读 `screen.getCursorScreenPoint()`，按「狗 → 鼠标」的方向（9 帧、约 40° 一档）选注视帧，切换时有 ~120ms 淡入。

## 🤖 接入 Claude Code（实时任务状态）

桌宠会反映**这个项目**里 Claude Code 的状态（通过本项目 `.claude/settings.json` 里的 hooks）：

| 状态 | 触发（hook） | 桌宠表现 |
| --- | --- | --- |
| ⚙️ 工作中 | `UserPromptSubmit` | 停止乱走，专注坐着（眼睛仍跟随你），头顶 ⚙️ |
| ❗ 等你确认 | `Notification` | 警觉坐姿，头顶 ❗ |
| ✅ 已完成 | `Stop` | 开心「汪」一声 + 头顶 ✅ + 弹系统通知「✅ 任务完成」，随后恢复正常 |

**原理**：桌宠主进程在 `127.0.0.1:4319` 起一个本地监听；hooks 用 `curl` 把事件转发过去（桌宠没开时 `curl` 秒失败、不影响 Claude Code）。

**范围**：当前只监听**本项目**目录里跑的 Claude Code（在 `桌宠/.claude/settings.json`）。想全局监听（任何项目都提醒），把这些 hooks 搬到 `~/.claude/settings.json` 即可。

## 📂 拖文件/文件夹给它 → 在终端启动 Claude Code

把 Finder 里的**文件或文件夹拖到狗狗身上**：会打开 **Terminal**，`cd` 到该位置并运行 `claude`；如果拖的是**文件**，会把 `@文件名` 预填到输入框（**不自动发送**），你决定说什么。

> ⚠️ **首次使用会弹两个 macOS 权限**（各点一次「允许」即可，之后不再问）：
> 1. **自动化**：允许「Electron」控制「Terminal」——打开终端需要它。
> 2. **辅助功能**：允许「Electron」——仅用于把 `@文件名` 预填进去（不给也能打开终端，只是不预填）。
>
> 要把文件**拖到身体上**（不透明区域）才接得住；拖到四角透明处会穿透过去。

## 实现要点

- **素材归一化**：5 组动作（走/挠头/叫/打滚/眼睛跟随，各 9 帧）统一到 420px 画布、同一条地面基线，切换姿势不跳动、大小一致。见 `assets/`。
- **像素级点击穿透**：默认 `setIgnoreMouseEvents(true,{forward:true})`，渲染进程对当前帧做 alpha 命中检测，只有指针压在不透明像素上才打开交互。翻转/呼吸缩放都画进 canvas（非 CSS），命中检测与所见一致。
- **安全**：`contextIsolation` 开、`nodeIntegration` 关，渲染进程经 `preload.js` 白名单 IPC 与主进程通信。

完整设计见 [SPEC.md](SPEC.md)（v1）与 [SPEC2.md](SPEC2.md)（v2 升级）。

## 文件结构

```
main.js            主进程：窗口、IPC、右键菜单、光标轮询、Claude hook 监听、拖文件起终端
preload.js         安全 IPC 桥（window.pet.*）
renderer/
  index.html       一个铺满窗口的 <canvas>
  style.css        透明、像素渲染
  pet.js           动画引擎 + 行为状态机 + 拖动/穿透 + 眼睛跟随 + Claude 状态层 + 拖放
assets/{walk,scratch,bark,roll,eyes}/01..09.png   归一化后的帧
.claude/settings.json   把 Claude Code hooks 转发给桌宠
```

## 调参

`renderer/pet.js` 顶部：`WIN`(大小，默认 160，**与 `main.js` 的 `WIN` 保持一致**)、
`WANDER`(默认 `false` 固定不乱跑；改 `true` 恢复溜达)、`WALK_SPEED`、
`REST_MIN/MAX`(休息时长)、`BREATH_AMT/PERIOD`(呼吸)、`GAZE_*`(眼睛跟随)、`ACTIVITY_WEIGHTS`(动作权重)。
`main.js` 顶部：`CLAUDE_PORT`(监听端口)、`CURSOR_POLL_MS`(光标轮询频率)。
