---
id: SPEC-E5
title: "E5 — 交付 → 下一轮迭代起点"
status: draft
type: edge
index: E5
fidelity: 80%
open-source-basis:
  - CUE dailyBrief.js (产品复盘，已有)
  - SPEC-L1 (下一轮从 L1 重新进入)
cue-seed:
  - server/services/dailyBrief.js
  - server/routes/reportRoutes.js
dependencies:
  - SPEC-E4
  - SPEC-L1
effort-weeks: 2
phase: 3
---

# SPEC-E5：交付 → 下一轮迭代起点

## 1. 目标

> 一个里程碑完成交付后，AI 自动生成"产品复盘"（完成了什么/阻塞了什么/关键决策/下一步），并把"下一步建议"作为下一轮迭代的输入种子，重新进入 L1 澄清流程。这是让整个环真正"转起来"的最后一条边。

## 2. 需求

- **REQ-E5-001**:（必须）里程碑所有任务 completed → 触发产品复盘生成
- **REQ-E5-002**:（必须）复盘包含：完成清单、阻塞项、关键决策、学到什么、下一步建议
- **REQ-E5-003**:（必须）"下一步建议"可以一键作为 L1 的输入，开启下一轮迭代
- **REQ-E5-004**:（应该）复盘写入 `eveningReports`（已有）并推送企微

## 3. 验收标准

- [ ] AC-E5-001: 里程碑完成 → 自动生成复盘报告
- [ ] AC-E5-002: 复盘包含"下一步建议"字段
- [ ] AC-E5-003: 点击"开启下一迭代"→ 下一步建议自动填入 L1 输入框
- [ ] AC-E5-004: 复盘推送企微（复用 dailyBrief 已有能力）

## 4. 技术方案

```
改动: server/services/dailyBrief.js
  - 新增 generateMilestoneRetrospective(milestone, completedTasks, store)
  - 输出: { summary, completed[], blocked[], decisions[], learnings, nextSuggestions[] }

新增路由: POST /api/milestones/:id/retrospective

前端: 复盘页点"开启下一迭代" → L1 输入框预填 nextSuggestions
```

## 5. 差距分析

| 能实现的 | 实现不了的 |
|---|---|
| 结构化复盘生成 | "学到了什么"的深度分析（需要大量历史数据）|
| 一键开启下一轮 | 跨团队的知识传递 |
| 企微推送 | — |

## 6. 实现笔记

> 待实现后更新。
