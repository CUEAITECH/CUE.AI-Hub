---
id: SPEC-E4
title: "E4 — 完成情况 → 实时调整阶段/里程碑"
status: draft
type: edge
index: E4
fidelity: 65%
open-source-basis:
  - Taskmaster `update` command mechanism
  - Closed-loop replanning (arXiv 2504.16563)
cue-seed:
  - server/services/docsManager.js (selectDailyDocTasks, docTasks snapshot)
  - server/services/semanticLinker.js
dependencies:
  - SPEC-E1
  - SPEC-E3
effort-weeks: 6
phase: 2
---

# SPEC-E4：完成情况 → 实时调整阶段/里程碑

## 1. 目标

> 当 E1（任务完成）或 E3（风险阻断）发出信号时，AI 自动评估当前里程碑是否需要调整（延期/重排/新增任务），把调整建议呈现给产品负责人确认，确认后执行。

**这是治"重复布置任务"的根本方案**。当前 CUE 是开环的——完成了什么、偏离了什么，对下一步的任务没有任何影响。E4 把这个回路焊上。

## 2. 需求

- **REQ-E4-001**:（必须）E1 信号积累（≥ N 个任务完成）→ 触发里程碑进度评估
- **REQ-E4-002**:（必须）E3 信号（Block 修复）→ 触发当前里程碑重排
- **REQ-E4-003**:（必须）评估结果呈现为"调整建议"，需人工确认后才执行（不自动改）
- **REQ-E4-004**:（必须）调整建议包含：哪些任务可以移除（已完成）/ 哪些需新增 / 里程碑预计完成日期变化
- **REQ-E4-005**:（应该）增量更新：只修改受影响的下游任务，不重解析全量文档
- **REQ-E4-006**:（应该）调整历史记录存档（`planAdjustments` 表已有）

## 3. 用户故事

```
作为产品负责人，当一个里程碑里 70% 的任务已完成，
AI 应该告诉我"M1 还差这 3 件事，建议本周内完成"，
而不是让我自己去数任务板。
验收：任务完成度 > 70% → AI 生成里程碑调整建议卡片，我点确认执行。
```

## 4. 验收标准

- [ ] AC-E4-001: 里程碑任务完成度 > 70% 时，自动触发调整建议生成
- [ ] AC-E4-002: 调整建议列出"可关闭"和"新增"任务
- [ ] AC-E4-003: 人工确认前，任务板不变化
- [ ] AC-E4-004: 确认后，store 更新，`planAdjustments` 记录该次调整
- [ ] AC-E4-005: 重新同步同一文档后，已完成任务 ID 保持不变（幂等，ADR-002）

## 5. 技术方案

### 触发机制（State-triggered，参考 arXiv 2504.16563）

```
事件触发（不是定时全量）:
  E1: task.status → completed
      [if 该里程碑完成度 > threshold] → scheduleReplanEval(milestoneId)

  E3: fixTask created（Block review）
      → scheduleReplanEval(milestoneId, urgency='high')

  手动: POST /api/milestones/:id/evaluate
```

### 评估 Prompt（借鉴 Taskmaster `update`）

```
系统：你是 CUE 的 AI 项目经理。
      根据当前里程碑的完成情况，建议最小化的调整方案。
      原则：只改受影响的任务，不重建整个计划。

输入：
  - 里程碑目标和验收标准
  - 已完成任务列表（含 evidenceRefs）
  - 未完成任务列表
  - 新增的 Block 修复任务（如有）

输出：
  {
    "assessment": "当前状态一句话描述",
    "completionPct": 75,
    "suggestedActions": [
      { "type": "close", "taskId": "...", "reason": "已由 PR#57 覆盖" },
      { "type": "add",   "title": "...", "priority": "P0", "reason": "..." },
      { "type": "redate","taskId": "...", "newDue": "2026-06-15", "reason": "..." }
    ],
    "milestoneForecast": "预计 2026-06-20 完成（原计划 2026-06-15）"
  }
```

### 增量更新逻辑（ADR-002 的核心实现）

```
// 替换掉现有的全量重解析
function applyPlanAdjustment(adjustment, store) {
  for (const action of adjustment.suggestedActions) {
    if (action.type === 'close') {
      updateTask(action.taskId, { status: 'completed', closedBy: 'e4' })
    } else if (action.type === 'add') {
      createTask({ ...action, id: hash(action.title + milestoneId) })
    } else if (action.type === 'redate') {
      updateTask(action.taskId, { dueDate: action.newDue })
    }
  }
  // 绝不清空现有任务，绝不重建 ID
}
```

## 6. 差距分析

| 能实现的 | 实现不了的 | 硬上限 |
|---|---|---|
| 基于 E1 信号的里程碑评估 | 纠偏决策的置信度（E1 80% + E3 83% → 信号不完美）| 依赖信号质量 |
| 增量更新（不冲零）| 完全自主执行（需人工确认）| Human-in-the-loop 必须保留 |
| 调整建议生成 | 预测里程碑完成时间（需历史数据）| 早期数据不足 |

## 7. 实现笔记

> 待实现后更新。
