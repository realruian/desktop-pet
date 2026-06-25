<div align="center">

# 🦛 河马 Hema

**一只住在 Mac 桌面上的像素河马 —— 既是陪伴你的桌宠，也是盯着 Claude Code 跑活的状态面板。**

它安静呼吸、四处溜达又自己走回原位，可随手拖动；接入 Claude Code 后头顶会实时显示任务状态，把文件夹拖给它就一键在终端开工，双击还能和它聊天、语音问答，甚至在你忙碌的间隙主动冒泡关心你。

<img src="docs/overview.svg" width="720" alt="河马功能总览" />

</div>

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [配置](#配置)
- [工作原理](#工作原理)
- [项目结构](#项目结构)
- [技术栈](#技术栈)
- [License](#license)

## 特性

**桌面陪伴**
- 大部分时间安静待机，带轻微呼吸起伏与偶尔眨眼
- 休息一阵后做个小动作或在「家」附近横向溜达，走完总会自己走回原位
- 1:1 跟手拖动到任意位置，落点即新家；轻点一下它会回应你
- 像素级点击穿透：只有身体能被点中，透明区域的点击直接落到下面的应用
- 悬浮于一切之上，跨工作区可见，全屏 app 也压不住它

**Claude Code 状态面板**
- 头顶一枚白色对话气泡：自绘指示器 + 任务名，宽度随文案自适应
- 🔵 在跑 / 🟡 等你确认 / ✅ 已完成（配系统通知），不画估算进度条
- 监听本机**所有项目**的会话，多任务并行时显示最新任务 + `＋N`

**聊天 & 语音**
- 双击河马身弹出浅色聊天卡片，打开即可直接打字（任意 OpenAI 兼容模型驱动）
- 麦克风语音输入，或在任意应用里长按 `⌥Space` 说话、松手自动转写发送
- 喊一声「河马河马」免按键唤醒 —— 唤醒词识别全程本地离线，不联网、不耗 API
- 可选接入 Obsidian 笔记库，提问时本地检索相关笔记作为参考

**主动互动**
- 河马时不时在头顶冒一个白色气泡关心你（久坐提醒 / 关心陪伴 / 卖萌唠嗑 / 按时段问候），配一声很轻的「叮」，频率与开关可调

**拖文件起终端**
- 把 Finder 的文件/文件夹拖到它身上，河马张嘴吃进去，同时打开 Terminal、`cd` 过去并运行 `claude`

**图形设置面板**
- 右键 → 设置：填 Key、下拉选主流模型、写自定义人设、设 Obsidian 库、开关语音唤醒与主动互动、一键测试连接，改完即时生效

> 不填任何配置也能玩：休息、走动、拖动、Claude 状态、主动互动都开箱即用；只有聊天 / 语音 / 笔记问答需要你自己的 API Key。

## 快速开始

> **环境要求**：macOS（Apple Silicon 或 Intel 均可）+ [Node.js](https://nodejs.org) 18+

```bash
git clone https://github.com/realruian/desktop-pet.git
cd desktop-pet
npm install
```

**打包成独立 App（推荐日常使用）**

```bash
npm run pack
cp -R dist/河马-darwin-*/河马.app /Applications/
```

双击「河马」即可启动，首次会注册开机自启（右键可关）。App 不占 Dock、不进 ⌘Tab，同时只运行一个实例。

> 首次打开若提示「无法验证开发者」（本地打的包没做苹果签名），**右键 →「打开」→ 再点「打开」** 即可，只需一次。

**开发模式（直接跑源码）**

```bash
npm start
```

启动后河马出现在主屏右下角，**右键 → 退出**。

## 配置

推荐在**右键 → 设置**的图形面板里完成所有配置，改完即时生效。也可手改 `~/Library/Application Support/hema-desktop-pet/config.json`（模板见 [`config.example.json`](config.example.json)）。

| 想做什么 | 怎么配 |
| --- | --- |
| 聊天 / 语音 | 填入 API Key（[OpenRouter](https://openrouter.ai) 或 [Moonshot](https://platform.moonshot.cn)），再从下拉里选模型 |
| 笔记问答 | 填上你的 Obsidian 库路径，启用本地检索 |
| 语音唤醒 / 主动互动 | 面板里有独立开关与频率/灵敏度调节，默认都开启 |

> 首次用「拖文件起终端」时，macOS 会请求**自动化**（控制 Terminal）与**辅助功能**（把 `@文件名` 预填进输入框）权限，各允许一次即可。Claude Code 状态监听依赖已注册到 `~/.claude/settings.json` 的 hooks，**已经开着的 Claude 会话需重启才会被监听**。

## 工作原理

<details>
<summary>Claude Code 状态联动</summary>

主进程在 `127.0.0.1:4319` 起一个本地 HTTP 监听；`~/.claude/settings.json`（全局）与本项目 `.claude/settings.json` 里的 hooks 用 `curl` 把会话事件转发过来（桌宠没开时 `curl` 秒失败，完全不影响 Claude Code）。状态按 session 跟踪后合并展示，两份 hooks 并存时按（事件, 会话）600ms 去重。Claude Code 没有真实「百分比」，所以气泡只声称它真正知道的事 —— 还在跑 / 等确认 / 跑完。
</details>

<details>
<summary>拖文件起终端（影子接驳窗）</summary>

两条 macOS 实测规则决定了实现：① 配置过点击穿透的窗口永远收不到拖拽事件；② 拖拽期间系统不派发鼠标事件。所以用一个微型 python 子进程（pyobjc）盯住系统拖拽剪贴板 + 鼠标键状态，发现你在拖文件时，立刻在河马位置显示一个隐形、从未穿透过的「接驳窗」接住投放并转发给河马，松手即隐藏 —— 像素级穿透零损失。落下后通过 `osascript` 打开 Terminal 执行命令。需要系统有 `python3` + `pyobjc`（缺了只影响拖放）。
</details>

<details>
<summary>语音唤醒 & 语音输入</summary>

唤醒：一个隐藏窗口用 Web Audio 采麦克风、降到 16kHz 串流给主进程，主进程用 **sherpa-onnx**（WenetSpeech 中文 KWS 模型，约 5.5MB，在 `assets/kws/`）做离线关键词检测，纯本地无网络。命中后进入语音活动检测（VAD）录音，说完停顿约 1.2 秒自动转写发送。输入：`MediaRecorder` 录音 → 重采样为 16kHz WAV → 交主进程用音频模型逐字转写 → 文本走正常聊天链路。缺原生模块时自动降级为「无唤醒」。
</details>

<details>
<summary>聊天 & Obsidian 检索</summary>

聊天请求在主进程完成（API Key 永不进渲染层），每次发送时现读本地 `config.json`。Obsidian 检索是轻量本地 RAG：把问题切成中文双字 + 英文词，扫描库内全部 `.md`，按命中数打分（标题命中加权），取最相关几篇截取片段作为参考随问题发出，五百篇规模检索 <1 秒，全程不联网（除发给模型那一步）。
</details>

## 项目结构

```
main.js              主进程：窗口 / IPC / 菜单 / Claude hook 监听 / 拖文件起终端 / 聊天 / 语音唤醒 / 设置
kws.js               语音唤醒引擎（封装 sherpa-onnx）
preload*.js          各窗口的安全 IPC 桥（pet / chat / settings / catcher / listener）
renderer/
  pet.js             动画引擎 + 行为状态机 + 拖动/穿透 + Claude 状态气泡 + 主动互动 + 拖放
  chat.*             聊天面板（浅色气泡 + 输入框 + 语音/VAD）
  settings.*         图形设置面板
  catcher.* / listener.*   隐形拖放接驳窗 / 语音监听窗
assets/              动画帧 + 离线唤醒模型
build/               打包资源与脚本（pack.js / icon.icns / 权限声明）
config.example.json  配置模板
```

完整实现规格见 [SPEC.md](SPEC.md) 与 [SPEC2.md](SPEC2.md)。

## 技术栈

- **Electron** —— 透明、无边框、永远置顶、像素级点击穿透的桌面浮层
- **Canvas 2D** —— 逐帧像素动画与状态气泡手绘
- **sherpa-onnx** —— 离线中文关键词检测；**Web Audio** —— 录音与重采样
- **Node `http`** —— Claude Code hook 监听；**AppleScript / osascript** —— 驱动 Terminal
- 安全模型：`contextIsolation` 开、`nodeIntegration` 关，渲染层经 `preload` 白名单 IPC 通信

## License

本项目以 MIT 协议开源。
