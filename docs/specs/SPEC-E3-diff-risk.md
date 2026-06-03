---
id: SPEC-E3
title: "E3 — diff 风险 → 阻断 / 新建修复任务"
status: draft
type: edge
index: E3
fidelity: 83%
open-source-basis:
  - CUE reviewer.js (mapReduceReviewer, already working)
  - CUE riskEngine.js (already working)
cue-seed:
  - server/services/reviewer.js
  - server/services/riskEngine.js
  - server/routes/reviewRoutes.js (182 reviews already working)
dependencies:
  - SPEC-L3
effort-weeks: 2
phase: 1
---

# SPEC-E3：diff 风险 → 阻断 / 新建修复任务

## 1. 目标

> PR diff 经 AI review 产出风险等级后，把结果**回流到任务板**：Block/Escalate 等级自动建修复任务，同时阻断该 PR 的里程碑进度计入，直到修复任务完成。

**当前状态**：`reviewer.js` 已产出 182 条 review（Pass76/Warning61/Block29/Escalate16），工作正常。问题是：review 结果停留在 reviews 表，**没有回流到任务和里程碑**。本 Spec 主要是"接线"，不是造新轮子。

## 2. 需求

- **REQ-E3-001**:（必须）PR review 等级 `Block` → 自动建"修复：[问题简述]"任务，关联原任务
- **REQ-E3-002**:（必须）PR review 等级 `Escalate` → 通知负责人，暂停 PR 进度计入
- **REQ-E3-003**:（必须）`Warning` → 在 PR 详情标注，不阻断，不建任务
- **REQ-E3-004**:（必须）修复任务完成并重新 review 通过后，原 PR 恢复正常进度
- **REQ-E3-005**:（应该）Block/Escalate 的 review 自动推送企微通知

## 3. 验收标准

- [ ] AC-E3-001: PR 收到 Block review → 10 分钟内 hub 出现修复任务
- [ ] AC-E3-002: Block 修复任务关联到原任务（dependencies 字段）
- [ ] AC-E3-003: 修复任务完成前，原 PR 的 task 不计入里程碑 completed
- [ ] AC-E3-004: Warning review 仅显示，不触发任何自动动作

## 4. 技术方案

### 接线点（最小改动）

```
现有流程:
  PR webhook → reviewer.js → reviews 表（stop）

改为:
  PR webhook → reviewer.js → reviews 表
                           → [if Block/Escalate] createFixTask()
                                 ↓
                           → updateStore: fixTask 关联 originalTaskId
                           → [if Block] set originalTask.blocked = true
                           → [if Escalate] wecom.push(负责人)

fixTask schema:
  {
    title: "修复：{review.summary}",
    description: review.details,
    priority: "P0",
    owner: originalTask.owner,
    dependencies: [originalTask.id],
    sourceReview: review.id,
    type: "fix"   // 新增字段，区分 AI 建的修复任务
  }
```

### CUE 接入点

```
改动: server/routes/reviewRoutes.js
  - PATCH /api/reviews/:id（更新 review 等级后）→ 触发 E3 处理

新增: server/services/reviewTaskLinker.js（轻量，<50行）
  - handleReviewOutcome(review, store): 建修复任务 / 推送通知
```

## 5. 差距分析

| 能实现的 | 实现不了的 |
|---|---|
| Block/Escalate → 自动建修复任务 | review 误判率（约 15%）可能建不必要的修复任务 |
| 里程碑进度 hold | 区分"架构问题"vs"小 bug"的粒度 |
| 修复完成后恢复 | 跨多个 PR 的连锁风险 |

## 6. 实现笔记

> 待实现后更新。
