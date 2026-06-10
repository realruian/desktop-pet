# 🐕 桌宠 / Mochi Pet（`desktop-pet`）

一只住在 Mac 桌面右下角的像素柯基：安静休息、**眼睛跟随你的鼠标**、偶尔做个小动作、可以随手拖动；还能**接入 Claude Code 实时显示任务状态**（头顶一条**迷你进度条**），并支持**把文件/文件夹拖给它一键在终端启动 Claude Code**。

![corgi](主图.png)

## 背景 / 动机

每天对着终端跑 Claude Code，长任务一跑就是几十分钟，盯着滚动的日志既累又容易分神。于是给自己做了个「会陪着我」的桌面伙伴：

- 平时它就安安静静趴在屏幕角落，眼睛跟着鼠标转，存在感低但有温度；
- 一旦本项目里的 Claude Code 开始干活、需要确认、或任务完成，它会**用表情和系统通知第一时间告诉我**，不用再频繁切窗口盯日志；
- 想开一个新任务时，直接把文件夹拖到它身上，终端就自动 `cd` 过去把 `claude` 拉起来。

它把「桌面萌宠」和「开发工作流状态指示器」缝在了一起——既是玩具，也是趁手的小工具。

## 核心功能

| 能力 | 说明 |
| --- | --- |
| 😌 **安静休息（约 50% 时间）** | 大部分时间坐着不动，带轻微**呼吸**起伏；眼睛**跟随鼠标**转动（按方向命名的注视帧：右/右上/上/左上/左/下左/下 + 正视，鼠标贴脸时还会「看鼻子」斗鸡眼，切换有淡入） |
| 🐾 **原地小动作** | 休息一阵后做 1–2 个原地动作（挠头 / 叫 / 躺下打滚），然后继续休息。默认**不自己乱跑**，想让它溜达把 `pet.js` 里的 `WANDER` 改 `true` |
| 🖱️ **拖动 & 轻点** | 按住身体 1:1 跟手拖到任意位置；轻点一下它会「汪」一声 |
| 🫥 **像素级点击穿透** | 只有身体不透明像素能被点中，透明区域的点击直接穿透到下面的应用 |
| 🤖 **Claude Code 状态胶囊** | 头顶一枚对齐的迷你状态胶囊：**自绘小指示器**（蓝色旋转圈＝工作中 / 琥珀脉冲点＝等你确认 / 绿色对勾＝完成，伴随系统通知）+ **任务名**（你提交的 prompt 文本，放不下自动截断）+ 细进度条，三件套排成一体，反映**本项目**里 Claude Code 的实时状态 |
| 📊 **迷你进度条** | 胶囊下沿一条 3px 细进度条：按「已用时长 + 已完成工具调用数」**渐近**估算进度（工作中最多 ~90%，不虚标），任务真正结束（Stop）时才填满变绿，随后整个胶囊淡出 |
| 📂 **拖文件起终端** | 把 Finder 的文件/文件夹拖到它身上 → 打开 Terminal、`cd` 过去并运行 `claude`；拖的是文件时还会把 `@文件名` 预填进输入框（不自动发送） |
| 🖱️ **右键菜单** | 暂停/继续走动、退出 |

### 原理简述

- **状态联动**：主进程在 `127.0.0.1:4319` 起一个本地 HTTP 监听；本项目 `.claude/settings.json` 里的 hooks 用 `curl` 把 `UserPromptSubmit / PostToolUse / Notification / Stop / SubagentStop` 事件转发过去（桌宠没开时 `curl` 秒失败、完全不影响 Claude Code）。
- **状态胶囊**：任务名取自 `UserPromptSubmit` hook 携带的 prompt 文本（缺省退化为项目目录名）；指示器（旋转圈/脉冲点/对勾）全部用 Canvas 路径**手绘**，几个像素也保持锐利，不用 emoji。
- **迷你进度条**：Claude Code 没有真实「百分比」，所以进度条用「已用时长 + 已完成工具调用数（`PostToolUse`）」拟合一个**渐近**估计值——工作中最多涨到 ~90%，只有任务真正结束（`Stop`）才填满。好处是它一直在动、又绝不虚报完成。
- **眼睛跟随**：主进程每 ~33ms 读 `screen.getCursorScreenPoint()`，按「狗 → 鼠标」方向选注视帧并淡入。
- **拖文件起终端**：通过 `osascript` 驱动 AppleScript 打开 Terminal 并执行命令；预填 `@文件名` 需要一次「辅助功能」授权。

## 技术栈

- **Electron 33**（透明 / 无边框 / 永远置顶 / 像素级点击穿透的桌面浮层窗口）
- **原生 Canvas 2D** 绘制逐帧像素动画（翻转、呼吸缩放都画进 canvas，命中检测与所见一致）
- **Node 内置 `http`** 实现 Claude Code hook 本地监听；**`osascript` / AppleScript** 驱动 Terminal
- 安全模型：`contextIsolation` 开、`nodeIntegration` 关，渲染进程经 `preload.js` 白名单 IPC 与主进程通信
- 像素素材由 Python（PIL）脚本生成 + 归一化（生成脚本与中间产物未纳入仓库，详见「目录结构」）

## 如何运行

需要 macOS + Node.js。

```bash
npm install      # 安装依赖（Electron）
npm start        # 启动桌宠（等价于 electron .）
```

启动后柯基出现在主屏**右下角**。退出：**右键 → 退出**。

> ⚠️ 首次用「拖文件起终端」会弹两个 macOS 权限，各点一次「允许」即可：
> 1. **自动化**：允许 Electron 控制 Terminal（打开终端需要）。
> 2. **辅助功能**：允许 Electron（仅用于把 `@文件名` 预填进去，不给也能打开终端、只是不预填）。

想让桌宠监听**任意项目**的 Claude Code，把 `.claude/settings.json` 里的 hooks 搬到 `~/.claude/settings.json` 即可。

## 目录结构

```
main.js                 主进程：透明窗口 / IPC / 右键菜单 / 光标轮询 / Claude hook 监听 / 拖文件起终端
preload.js              安全 IPC 桥（暴露 window.pet.*）
renderer/
  index.html            铺满窗口的单个 <canvas>
  style.css             透明、像素渲染
  pet.js                动画引擎 + 行为状态机 + 拖动/穿透 + 眼睛跟随 + Claude 状态层 + 拖放
assets/{walk,scratch,bark,roll,eyes}/01..09.png   App 实际加载的归一化帧（420 画布、同一地面基线）
.claude/settings.json   把 Claude Code hooks 转发给桌宠
SPEC.md / SPEC2.md      v1 与 v2 的完整实现规格
主图.png                 展示用主图
```

> 说明：`像素狗狗动作帧/`（原始动画帧 dump）、`make_mochi_pet.py` 及各 `*_run/`（像素生成实验的 PyInstaller 运行产物）体积大且与运行无关，**仅在本地留档、已通过 `.gitignore` 排除**。App 运行只依赖 `assets/` 下的归一化帧。

## 当前状态

可用（v2）。已实现：固定休息 + 呼吸、眼睛跟随鼠标、像素级点击穿透、1:1 拖动、Claude Code 状态胶囊（任务名 + 迷你进度条 + 系统通知）、拖文件/文件夹起终端。默认关闭自主乱跑（`WANDER=false`）。

常用调参见 `renderer/pet.js` 顶部（`WIN` / `WANDER` / `WALK_SPEED` / `REST_MIN/MAX` / `BREATH_*` / `GAZE_*` / `CHIP_*` / `PROG_*` / `ACTIVITY_WEIGHTS`）与 `main.js` 顶部（`CLAUDE_PORT` / `CURSOR_POLL_MS`）。完整设计见 [SPEC.md](SPEC.md)（v1）与 [SPEC2.md](SPEC2.md)（v2）。

---

作者：一名 AI 产品经理、「驾驭工程」（让产品经理用 AI 直接把想法做成可跑的东西）的倡导者。本项目即一次 vibe coding 的产物。License: MIT。
