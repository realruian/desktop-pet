# 🐕 柯基桌宠 (Corgi Desktop Pet)

一只基于你的像素素材做的 Mac 桌面宠物：会**自己随机走动**、**可以拖动**，窗口透明、无边框、永远置顶，空白处可以**点击穿透**到下面的应用。

![corgi](主图.png)

## 运行

```bash
npm install      # 安装依赖（Electron）
npm start        # 启动桌宠
```

启动后柯基会出现在屏幕**右下角**。

## 功能

| 交互 | 行为 |
| --- | --- |
| 🖱️ **拖动** | 按住狗狗身体拖到任意位置，1:1 跟手 |
| 👆 **轻点** | 在身上点一下（不拖动），狗狗会「汪」地叫一声 |
| 🚶 **随机走动** | 发呆 2.5–6 秒后，随机选择：走到屏幕某处 / 挠头 / 叫 / 躺下打滚 |
| 🖱️➡️ **点击穿透** | 只有狗狗身体能点；透明区域的点击会穿透到下面的应用 |
| 🖱️ **右键** | 菜单：暂停/继续走动、退出 |

走路时狗狗会自动朝向移动方向（素材默认朝左，向右走时水平翻转）。

## 退出

右键狗狗 → **退出**。

## 实现要点

- **素材归一化**：4 组动作（走路 / 挠头 / 叫 / 打滚，各 9 帧）统一到 420px 画布、
  同一条「地面基线」，所以切换姿势时不会上下跳动，大小一致。见 `assets/`。
- **像素级点击穿透**：主进程默认 `setIgnoreMouseEvents(true,{forward:true})`，渲染进程
  对当前帧做 alpha 命中检测，只有指针压在不透明像素上时才打开交互。水平翻转直接画进
  canvas（不是 CSS），保证命中检测和看到的像素完全一致。
- **拖动**：Pointer Events 手动实现，主进程负责 `setPosition`，与随机走动复用同一条移动通路。
- **安全**：`contextIsolation` 开、`nodeIntegration` 关，渲染进程通过 `preload.js` 的
  白名单 IPC 与主进程通信。

完整设计见 [SPEC.md](SPEC.md)。

## 文件结构

```
main.js            主进程：窗口、IPC、右键菜单
preload.js         安全 IPC 桥（window.pet.*）
renderer/
  index.html       一个铺满窗口的 <canvas>
  style.css        透明、像素渲染
  pet.js           动画引擎 + 行为状态机 + 拖动/穿透
assets/{walk,scratch,bark,roll}/01..09.png   归一化后的帧
```

## 调参

常用参数在 `renderer/pet.js` 顶部：`WIN`(窗口大小)、`WALK_SPEED`、`IDLE_MIN/MAX`、
各动作 `fps`、行为权重 `BEHAVIOR_WEIGHTS`。
