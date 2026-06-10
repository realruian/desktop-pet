# 🐕 桌宠 / Mochi Pet（`desktop-pet`）

一只住在 Mac 桌面右下角的像素柯基：安静休息、**眼睛跟随你的鼠标**、在家附近溜达又**自己走回原位**、可以随手拖动；能**接入 Claude Code 实时显示任务状态**（头顶一枚**迷你状态胶囊**）、**把文件/文件夹拖给它一键在终端启动 Claude Code**，还能**双击它直接和它聊天（Kimi 驱动）**。

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
| 🐾 **小动作 & 家附近溜达** | 休息一阵后做 1–2 个动作（挠头 / 叫 / 打滚 / 散步）。散步**只横着走**（走路素材是侧面像，斜着滑很怪），在「家」左右 **240px** 内选目标，走完**一定先走回家**再趴下——绝不越走越远。拖动它＝搬家，落点就是新家。不想让它动：右键 → 暂停走动，或把 `pet.js` 的 `WANDER` 改 `false` |
| 🖱️ **拖动 & 轻点** | 按住身体 1:1 跟手拖到任意位置（落点成为新家）；轻点一下它会「汪」一声 |
| 💬 **和多吉聊天（Kimi）** | **双击狗身**或右键 → 💬 聊天，弹出贴在它头顶的聊天小卡片。多吉人设、中文短句、偶尔「汪！」；历史在会话内保留。接口兼容 OpenRouter / Moonshot 直连 |
| 🎤 **跟它说话（语音输入）** | 聊天卡片里按一下 🎤 开始说话、再按一下结束：录音在本地转成 16kHz WAV → 音频模型**逐字转写**（带「多吉」热词，名字不会听岔）→ 转写文本自动作为消息发出 → 多吉用文字气泡回复。首次使用 macOS 会弹一次麦克风授权 |
| ⌨️ **全局长按说话（⌥Space）** | 在**任何应用里**按住 `Option+Space`：聊天窗瞬间弹出开始录音（提示「多吉在听…松开按键自动发送」），**松手即停**、自动转写发送。再按一次快捷键或点 ■ 也能结束；快捷键可在 `config.json` 的 `hotkey.ptt` 改 |
| 📓 **用你的 Obsidian 笔记回答** | 在 `config.json` 填上库路径后，每次提问它会**本地检索**你的笔记（中文双字匹配 + 标题加权），把最相关的几段作为参考来回答，并自然提到出自哪篇笔记；没翻到就老实说。纯本地文件扫描，笔记内容只随这一次提问发给模型 |
| 🫥 **像素级点击穿透** | 只有身体不透明像素能被点中，透明区域的点击直接穿透到下面的应用 |
| 📌 **悬浮于一切之上** | `screen-saver` 窗口层级 + 跨空间可见，普通应用、浮动面板、全屏 app 都压不住它 |
| 🤖 **Claude Code 状态胶囊（全机监听）** | 头顶一枚单行迷你胶囊：**自绘小指示器** + **任务名**。只显示真实知道的事——🔵 旋转圈＝在跑 / 🟡 琥珀脉冲＝等你确认 / ✅ 绿勾闪现＝完成（配一声「汪！」+ 系统通知），不再画「估算进度条」。监听**这台机器上所有项目**的 Claude Code 会话：多任务并行时显示最新任务名 + `＋N` 后缀，等确认的任务优先展示；每完成一个就闪一次 ✅，全部结束后胶囊淡出。终端直接关掉的会话静默清除，沉默 15 分钟自动遗忘 |
| 📂 **拖文件起终端** | 把 Finder 的文件/文件夹拖到它身上 → 打开 Terminal、`cd` 过去并运行 `claude`；拖的是文件时还会把 `@文件名` 预填进输入框（不自动发送） |
| 🖱️ **右键菜单** | 暂停/继续走动、退出 |

### 原理简述

- **状态联动**：主进程在 `127.0.0.1:4319` 起一个本地 HTTP 监听；`~/.claude/settings.json`（全局，覆盖所有项目）和本项目 `.claude/settings.json` 里的 hooks 用 `curl` 把 `UserPromptSubmit / PostToolUse / Notification / Stop / SessionEnd` 事件转发过去（桌宠没开时 `curl` 秒失败、完全不影响 Claude Code）。状态**按 session 跟踪**后合并展示；两份 hooks 并存时主进程按（事件, 会话）600ms 去重，不会重复触发。注意：hooks 在会话启动时加载，**已经开着的 Claude 会话需要重启才会被监听**。
- **状态胶囊**：任务名取自 `UserPromptSubmit` hook 携带的 prompt 文本（缺省退化为项目目录名）；指示器（旋转圈/脉冲点/对勾）全部用 Canvas 路径**手绘**，几个像素也保持锐利，不用 emoji。
- **为什么没有进度条**：Claude Code 没有真实「百分比」，能确定的只有「还在跑 / 跑完了」。所以胶囊只声称它真正知道的事，完成那一刻用 ✅ + 一声汪明确告诉你。
- **眼睛跟随**：主进程每 ~33ms 读 `screen.getCursorScreenPoint()`，按「狗 → 鼠标」方向选注视帧并淡入。
- **拖文件起终端**：通过 `osascript` 驱动 AppleScript 打开 Terminal 并执行命令；预填 `@文件名` 需要一次「辅助功能」授权。
- **Kimi 聊天**：请求在**主进程**完成（API Key 永不进渲染层）；Key/模型/接口地址放在 gitignore 掉的本地 `config.json`（模板见 `config.example.json`），每次发送时现读——填好 Key 即刻生效、无需重启。柯基人设通过 system prompt 注入。任何 OpenAI 兼容接口均可（默认 OpenRouter 路由 `moonshotai/kimi-k2.5`，也可 Moonshot 直连）。
- **Obsidian 检索**：轻量本地 RAG——把问题切成中文双字组合 + 英文词，扫描库内全部 `.md`（跳过 `.obsidian`/Excalidraw，单文件 ≤200KB，上限 4000 篇），按命中数打分（标题命中 ×4 加权），取最相关 4 篇、每篇截取命中处约 420 字，作为 system 参考消息随问题发出。五百篇规模检索耗时 <1 秒，全程不联网（除发给模型那一步）。
- **语音输入**：渲染层 `MediaRecorder` 录 webm/opus → `decodeAudioData` + `OfflineAudioContext` 重采样为 16kHz 单声道 → 手写 WAV 编码 → base64 交主进程 → 以 `input_audio` 调同一 OpenRouter Key 下的音频模型（默认 `google/gemini-2.5-flash`，`config.json` 的 `stt.model` 可换）逐字转写 → 转写文本走正常聊天链路。单次录音上限 1 分钟；麦克风权限由主进程 `askForMediaAccess` 申请。
- **全局长按说话**：Electron 的全局快捷键只有「按下」没有「松开」事件，所以按下由 `globalShortcut` 触发（弹出聊天窗并开录），「松手」由获得焦点的聊天窗监听 keyup 结束；兜底：再按一次快捷键、点 ■、或 60 秒上限。聊天窗启动时预创建（隐藏），保证弹出零等待。

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

**开启 Kimi 聊天**：把 `config.example.json` 复制为 `config.json`，填入你的 API Key——[OpenRouter](https://openrouter.ai)（`sk-or-` 开头，可路由 Kimi 等数百模型）或 [Moonshot 直连](https://platform.moonshot.cn) 均可——无需重启。`config.json` 已被 `.gitignore` 排除，Key 只留在你本机。

**开启笔记问答**：在 `config.json` 的 `obsidian.vault` 填上你的 Obsidian 库路径即可（vault 列表可在 `~/Library/Application Support/obsidian/obsidian.json` 查到）。

> ⚠️ 首次用「拖文件起终端」会弹两个 macOS 权限，各点一次「允许」即可：
> 1. **自动化**：允许 Electron 控制 Terminal（打开终端需要）。
> 2. **辅助功能**：允许 Electron（仅用于把 `@文件名` 预填进去，不给也能打开终端、只是不预填）。

桌宠默认监听**全机所有项目**的 Claude Code（hooks 已注册到 `~/.claude/settings.json`；本项目的 `.claude/settings.json` 留有一份同样的 hooks 供克隆者开箱即用，两者并存不会重复触发）。

## 目录结构

```
main.js                 主进程：透明窗口 / IPC / 右键菜单 / 光标轮询 / Claude hook 监听 / 拖文件起终端 / Kimi 聊天
preload.js              桌宠窗口的安全 IPC 桥（暴露 window.pet.*）
preload-chat.js         聊天窗口的安全 IPC 桥（暴露 window.chat.*）
renderer/
  index.html            铺满窗口的单个 <canvas>
  style.css             透明、像素渲染
  pet.js                动画引擎 + 行为状态机 + 拖动/穿透 + 眼睛跟随 + Claude 状态胶囊 + 拖放
  chat.html/css/js      聊天面板（气泡列表 + 输入框）
config.example.json     Kimi 配置模板（复制为 config.json 填 Key；config.json 不入库）
assets/{walk,scratch,bark,roll,eyes}/   App 实际加载的归一化帧（420 画布、同一地面基线）
.claude/settings.json   把 Claude Code hooks 转发给桌宠
SPEC.md / SPEC2.md      v1 与 v2 的完整实现规格
主图.png                 展示用主图
```

> 说明：`像素狗狗动作帧/`（原始动画帧 dump）、`make_mochi_pet.py` 及各 `*_run/`（像素生成实验的 PyInstaller 运行产物）体积大且与运行无关，**仅在本地留档、已通过 `.gitignore` 排除**。App 运行只依赖 `assets/` 下的归一化帧。

## 当前状态

可用（v6）。已实现：休息 + 呼吸、眼睛跟随鼠标、像素级点击穿透、1:1 拖动、家附近横向溜达 + 自动回家、悬浮于一切应用之上、Claude Code 状态胶囊（全机多会话、任务名、完成 ✅+汪 + 系统通知）、拖文件/文件夹起终端、和多吉聊天（双击狗身，Kimi）、语音说话（🎤 转写后文字回复）、Obsidian 笔记问答。

常用调参见 `renderer/pet.js` 顶部（`WIN` / `DOG` / `WANDER` / `HOME_RANGE` / `STROLL_MIN` / `WALK_SPEED` / `REST_MIN/MAX` / `BREATH_*` / `GAZE_*` / `CHIP_*` / `PROG_*` / `ACTIVITY_WEIGHTS`）与 `main.js` 顶部（`CLAUDE_PORT` / `CURSOR_POLL_MS` / `CHAT_W/H` / `PERSONA` / `VAULT_*`）。完整设计见 [SPEC.md](SPEC.md)（v1）与 [SPEC2.md](SPEC2.md)（v2）。

---

作者：一名 AI 产品经理、「驾驭工程」（让产品经理用 AI 直接把想法做成可跑的东西）的倡导者。本项目即一次 vibe coding 的产物。License: MIT。
