---
id: SPEC-XX
title: "组件名称"
status: draft          # draft | active | implemented | deprecated
type: layer            # layer | edge
index: 0               # 对应 Layer 1-5 或 Edge E1-E5
fidelity: 0%           # 当前可实现度
open-source-basis:     # 借鉴的开源方案
  - ""
cue-seed:              # CUE 已有的种子代码
  - ""
dependencies:          # 依赖哪些其他 SPEC
  - ""
effort-weeks: 0
phase: 1               # 建议在哪个 Phase 实现
---

# SPEC-XX：组件名称

## 1. 目标

> 一句话：这个组件做什么，解决什么问题。

## 2. 需求（Requirements）

每条需求有唯一 ID，供后续 commit / task 追溯。

### 功能需求

- **REQ-XX-001**: （必须）…
- **REQ-XX-002**: （必须）…
- **REQ-XX-003**: （应该）…

### 非功能需求

- **REQ-XX-NFR-001**: 性能 / 可靠性 / 成本约束

## 3. 用户故事

```
作为 [角色]，我希望 [操作]，以便 [收益]。
验收：[可测量的完成标准]
```

## 4. 验收标准（Acceptance Criteria）

可被 AI PM 直接转成任务验收的格式：

- [ ] AC-001: …
- [ ] AC-002: …
- [ ] AC-003: …

## 5. 技术方案

### 开源组件借鉴

| 借谁 | 借什么（具体机制/schema/prompt） | 微调点 |
|---|---|---|
| | | |

### CUE 接入点

```
现有代码: server/services/xxx.js
改动方式: 扩展 / 替换 / 接线
新增文件: 
```

### 数据流

```
输入 → 处理 → 输出
```

## 6. 差距分析

| 能实现的 | 实现不了的（原因） | 硬上限 |
|---|---|---|
| | | |

## 7. 实现不了的部分的应对

> Human-in-the-loop 方案 / 降级策略 / 等待工具链成熟

## 8. 实现笔记（动态更新）

> 实现过程中的发现、偏离计划的地方、后续任务调整。
