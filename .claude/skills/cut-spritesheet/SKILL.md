---
name: cut-spritesheet
description: 把桌宠角色的精灵表(spritesheet)切成 app 需要的 33 个命名帧（420×420 透明 PNG）。当用户要「切图 / 切割精灵表 / 切角色素材 / 换新角色 / cut spritesheet / 把这个角色切了 / 加个新桌宠角色」时触发。输入是一张 1536×1872 的同款生成器精灵表，输出 walk/scratch/wave/cheer/roll/expressions 帧。不处理眼神(eyes)。
---

# 切割桌宠精灵表

把「桌宠生成器」产出的一张精灵表，切成本项目 `assets/` 需要的命名帧。

## 一句话用法

```bash
python3 build/cut-spritesheet.py <角色目录或精灵表路径> [输出目录]
```

- 传**角色目录**（内含 `spritesheet.webp`）→ 在该目录生成 `frames/`
- 传**精灵表文件路径**（.webp / .png 均可）→ 在其旁边生成 `frames/`
- 可选第二个参数指定输出目录

例：
```bash
python3 build/cut-spritesheet.py ~/Downloads/桌宠素材/luffy-2-pet
# → ~/Downloads/桌宠素材/luffy-2-pet/frames/{walk,scratch,wave,cheer,roll,expressions}/
```

依赖：系统 Python3 + Pillow（已装，无需额外安装）。脚本本体：[build/cut-spritesheet.py](../../../build/cut-spritesheet.py)。

## 精灵表布局（固定，同款生成器）

- 尺寸 **1536×1872**，网格 **8 列 × 9 行**，单元格 **192×208**。
- 行↔状态映射（从已切好的 hema 资产反向匹配确认，非猜测）：

| 行 row | 用到的列 | 输出状态 | 帧数 |
|--------|----------|----------|------|
| 2 | c7→c0（**反向**） | `walk` 走路侧面 | 8 |
| 8 | c0→c5 | `scratch` 抱臂待机 | 6 |
| 3 | c0→c3 | `wave` 挥手 | 4 |
| 4 | c0→c4 | `cheer` 欢呼 | 5 |
| 6 | c0→c5 | `roll` 转头卖萌 | 6 |
| 5 | c0→c3 | `expressions` 委屈脸 tearful 1→4 | 4 |

共 **33 帧**。row0/row1/row7、row5 后半是生成器多出来的姿势，本项目不用。

## 框定规则（已验证能复现现有帧，视觉无差）

裁出单元格 → 取 alpha 包围盒 → 等比缩放（**内容高=350px，但宽度不超过 404px，取更小的比例**）→ 贴到 420×420 透明画布：**水平居中(x=210)，底边贴 baseline y=388**。这些常量与 `renderer/pet.js` 的 `SRC=420` / `BASELINE=388` 对齐，改动需同步。

> 宽度上限很关键：皮卡丘这种「帽子+长尾巴」的超宽角色，只按高度放大会让宽度超过 420 画布、左右被裁掉。宽高双约束保证整体完整放进画布（超宽角色只是整体矮一点，脚仍贴 baseline）。

## 换角色完整流程

1. 跑脚本切出 `frames/`。
2. **肉眼核对**输出（尤其 `expressions/`，见下方坑），可以拼一张 contact sheet 看。
3. 把 `frames/` 里的内容覆盖进项目 `assets/` 对应子目录。
4. `npm start` 跑起来确认动作正常。

## 坑 / 注意

- **不处理眼神**：`eyes/` 注视功能已从 app 删除，脚本不输出眼神帧，无需理会。
- **expressions 行各角色不完全一致**：取的是 row5 前 4 格。hema 是 4 张递进哭脸，但有的角色第 4 格是「趴下蜷缩」姿势。换角色时务必瞄一眼 `frames/expressions/`，不合意就手动从 row5 其它格或别处挑。
- **walk 是反向排布的**：脚本已按 `[7,6,5,4,3,2,1,0]` 还原成正确播放顺序，别改。
- **网格非 8×9 会告警**：脚本按图宽高自动推断列/行数，若不是 8×9 会打印警告——说明这张表不是同款生成器，需先肉眼核对布局再决定是否硬切。
