---
id: SPEC-E1
title: "E1 — commit/PR 完成 → 任务状态自动翻转"
status: draft
type: edge
index: E1
fidelity: 80%
open-source-basis:
  - TraceLLM (arXiv 2602.01253)
  - semanticLinker (CUE 已有)
cue-seed:
  - server/services/semanticLinker.js (commitTaskLinks)
  - scanGitHubProject (拉 commits)
  - 24 个 task↔commit 已实证
dependencies: []
effort-weeks: 2
phase: 1
---

# SPEC-E1：commit/PR 完成 → 任务状态自动翻转

## 1. 目标

> PR 合并后，关联任务自动标记为 completed，不再依赖人工手点。这是整个闭环最关键的一条边——进度不真实，所有其他层都是空转。

**当前问题**：5/31 重解析把所有已完成任务冲零，根因是状态从不自动回写，去重完全失效。

## 2. 需求

### 功能需求

- **REQ-E1-001**:（必须）PR 合并事件 → 匹配关联 task → 自动将 task.status 改为 `completed`
- **REQ-E1-002**:（必须）匹配方式优先用 commit message 里的显式 `task_xxx` ID；无 ID 时用语义匹配（commit title vs task title）
- **REQ-E1-003**:（必须）一条 commit 可关联多个 task；一个 task 可被多条 commit 覆盖（部分完成）
- **REQ-E1-004**:（应该）部分覆盖时更新 task.progress（0-100），而非直接翻 completed
- **REQ-E1-005**:（应该）新任务导入时，先查现有 commitTaskLinks，若有覆盖 → 自动标 completed，不导入为 pending

### 非功能需求

- **REQ-E1-NFR-001**: 语义匹配准确率 ≥ 70%（TraceLLM benchmark 对标）；有显式 ID 时 ≥ 95%
- **REQ-E1-NFR-002**: 不能误标（假阳性：把没做完的标成 completed）优先级高于漏标

## 3. 用户故事

```
作为团队成员，合并了 PR 之后，我不需要手动回 hub 点完成，
任务状态会自动更新，下次导入不会把做完的活再派一遍。
验收：合并 PR → 5 分钟内 hub 任务状态翻转为 completed。
```

## 4. 验收标准

- [ ] AC-E1-001: 合并带有 `task_xxx` ID 的 PR → 对应任务在 hub 中自动变为 `completed`
- [ ] AC-E1-002: 合并无 task ID 的 PR，commit title 与任务标题语义相似度 ≥ 0.75 → 自动标 completed
- [ ] AC-E1-003: sync-docs 导入时，已 completed 的任务不会被重新导入为 pending
- [ ] AC-E1-004: 误标率（假阳性）< 5%（20 次测试中少于 1 次误标）

## 5. 技术方案

### 开源组件借鉴

| 借谁 | 借什么 | 微调点 |
|---|---|---|
| TraceLLM | 语义匹配 prompt：commit summary ↔ requirement sentence，用 cosine sim 打分 | 换成 task title 而非 formal requirement；加中文支持 |
| CUE semanticLinker | commitTaskLinks 数据结构已有 | 扩展：在匹配后直接触发 store 状态回写 |

### CUE 接入点

```
现有代码: server/services/semanticLinker.js → commitTaskLinks
改动:
  1. 在 semanticLinker 的 commitTaskLinks 生成后，遍历高置信度匹配
  2. 调用 updateStore 将对应 task.status 设为 completed（或更新 progress）
  3. 在 selectDailyDocTasks（docsManager.js:534）的过滤逻辑中，
     将"有 commit 覆盖的任务"加入 completedTitles，彻底去重

新增触发点:
  - Webhook 收到 PR merged 事件时触发一次 semanticLinker
  - daily-scan 流程里也跑一次
```

### 数据流

```
PR merged webhook
  → scanGitHubProject（拉最新 commits）
  → semanticLinker（生成 commitTaskLinks）
  → 遍历 links where confidence ≥ 0.75
  → updateStore: task.status = 'completed'（或 progress += delta）
  → selectDailyDocTasks: completedTitles 自动包含这些任务
  → 下次 sync-docs 不再重复导入
```

## 6. 差距分析

| 能实现的 | 实现不了的 | 硬上限 |
|---|---|---|
| 有 task ID 的精确匹配（95%+）| commit message 质量差时语义匹配失准 | 语义匹配天花板约 70-75%（无 ID 场景）|
| 中文任务标题匹配 | 一个 PR 跨多个不相关任务的归因 | 需要工程师写清楚 commit message |
| PR 粒度的状态翻转 | commit 粒度的子任务进度（过细）| 工程实现复杂度 vs 收益不成比 |

## 7. 应对策略

- 推行 commit message 规范（已有 `task_xxx_yyy` ID 体系）
- 语义匹配置信度低时，不自动翻转，而是推送"待确认"提醒
- 允许人工在 hub 覆盖 AI 的判断

## 8. 实现笔记

> 待实现后更新。
