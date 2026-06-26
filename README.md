<div align="center">

# 🦛 河马 Hema

**一只住在 Mac 桌面上的像素河马 —— 既是陪伴你的桌宠，也是盯着 Claude Code 跑活的状态面板。**

它安静呼吸、四处溜达又自己走回原位，可随手拖动；接入 Claude Code 后头顶会实时显示任务状态，把文件夹拖给它就一键在终端开工，双击还能和它聊天。

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
- 🔵 在跑（原地踏步）/ 🟡 等你确认 / ✅ 已完成（叮叮声 + 欢呼动作），不画估算进度条
- 监听本机**所有项目**的会话，多任务并行时显示最新任务 + `＋N`

**聊天 & 联网搜索**
- 双击河马身体、或在任意应用里**双击 Option 键**（可改为双击 Command，或禁用）弹出浅色聊天卡片
- 打开即可直接打字（任意 OpenAI 兼容模型驱动）
- 自动接入 OpenRouter 联网搜索插件，问实时信息模型会主动搜索
- 可选接入 Obsidian 笔记库，提问时本地检索相关笔记作为参考

**专注模式（番茄钟）**
- 右键 → 开始专注，可选 25 / 45 / 60 分钟（或 10 秒演示）
- 专注中右键显示剩余时间；到点自动触发欢呼庆祝

**主动互动**
- 河马时不时在头顶冒一个白色气泡关心你（久坐提醒 / 关心陪伴 / 卖萌唠嗑 / 按时段问候），配一声很轻的「叮」，频率与开关可调

**拖文件起终端**
- 把 Finder 的文件/文件夹拖到它身上，河马张嘴吃进去，同时打开 Terminal、`cd` 过去并运行 `claude`

**亲密度系统**
- 累计聊天和任务完成次数，逐步解锁新表情动作（泪眼婆娑 → 委屈巴巴 → 想贴贴 → 舍不得你 → 美滋滋）
- 右键 → 亲密度，实时查看解锁进度

**图形设置面板**
- 右键 → 设置：填 Key、下拉选主流模型、写自定义人设、设 Obsidian 库、开关主动互动、一键测试连接，改完即时生效

> 不填任何配置也能玩：休息、走动、拖动、Claude 状态、主动互动都开箱即用；只有聊天 / 笔记问答需要你自己的 API Key。

## 快速开始

> **环境要求**：macOS（Apple Silicon 或 Intel 均可）+ [Node.js](https://nodejs.org) 18+

```bash
git clone https://github.com/realruian/desktop-pet.git
cd desktop-pet
npm install
npm start
```

启动后河马出现在主屏右下角，**右键 → 退出**。

## 配置

推荐在**右键 → 设置**的图形面板里完成所有配置，改完即时生效。也可手改 `~/Library/Application Support/hema-desktop-pet/config.json`（模板见 [`config.example.json`](config.example.json)）。

| 想做什么 | 怎么配 |
| --- | --- |
| 聊天 / 联网搜索 | 填入 API Key（推荐 [OpenRouter](https://openrouter.ai)），再从下拉里选模型；OpenRouter 自动接入联网搜索 |
| 笔记问答 | 填上你的 Obsidian 库路径，启用本地检索 |
| 主动互动 | 在面板里开关与调频率，默认开启 |
| 呼出聊天快捷键 | 默认双击 Option；可在设置里改为双击 Command 或禁用；首次需在 系统设置 → 辅助功能 授权 |

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
<summary>聊天 & Obsidian 检索</summary>

聊天请求在主进程完成（API Key 永不进渲染层），每次发送时现读本地 `config.json`。启用 OpenRouter 时自动附带联网搜索插件（`plugins: [{ id: 'web' }]`），模型自主判断是否触发搜索。Obsidian 检索是轻量本地 RAG：把问题切成中文双字 + 英文词，扫描库内全部 `.md`，按命中数打分（标题命中加权），取最相关几篇截取片段作为参考随问题发出，五百篇规模检索 <1 秒，全程不联网（除发给模型那一步）。
</details>

## 项目结构

```
main.js              主进程：窗口 / IPC / 菜单 / Claude hook 监听 / 拖文件起终端 / 聊天 / 专注模式 / 设置
preload*.js          各窗口的安全 IPC 桥（pet / chat / settings / catcher）
renderer/
  pet.js             动画引擎 + 行为状态机 + 拖动/穿透 + Claude 状态气泡 + 主动互动 + 亲密度解锁
  chat.*             聊天面板（浅色气泡 + 输入框）
  settings.*         图形设置面板
  catcher.*          隐形拖放接驳窗
assets/              各角色精灵动画帧
config.example.json  配置模板
```

完整实现规格见 [SPEC.md](SPEC.md) 与 [SPEC2.md](SPEC2.md)。

## 技术栈

- **Electron** —— 透明、无边框、永远置顶、像素级点击穿透的桌面浮层
- **Canvas 2D** —— 逐帧像素动画与状态气泡手绘
- **Web Audio API** —— 合成提示音效（叮声）
- **Node `http`** —— Claude Code hook 监听；**AppleScript / osascript** —— 驱动 Terminal
- 安全模型：`contextIsolation` 开、`nodeIntegration` 关，渲染层经 `preload` 白名单 IPC 通信

## License

本项目以 MIT 协议开源。
