---
id: SPEC-L3
title: "L3 — 任务 → 自动建 PR / Branch"
status: draft
type: layer
index: 3
fidelity: 90%
open-source-basis:
  - GitHub API (already in use)
  - Spec Kit /tasks → PR pattern
cue-seed:
  - server/services/githubApi.js
  - 现有 PR 流（你们说 PR 流已能自动开 PR）
dependencies:
  - SPEC-L2
effort-weeks: 1
phase: 1
---

# SPEC-L3：任务 → 自动建 PR / Branch

## 1. 目标

> 任务被认领后，自动在目标仓库创建对应的 branch 和 draft PR，PR 描述从任务的 acceptance / businessNote / dependencies 自动生成，工程师接手即可开始工作。

**当前状态**：PR 流已基本跑通（你们确认），本 Spec 主要定义"PR 内容从任务 schema 自动生成"的标准。

## 2. 需求

### 功能需求

- **REQ-L3-001**:（必须）任务认领后，自动在 GitHub 创建 branch（命名：`feat/task_{taskId}_{shortTitle}`）
- **REQ-L3-002**:（必须）自动创建 draft PR，PR 描述包含：task businessNote + acceptance checklist + dependencies
- **REQ-L3-003**:（必须）PR 与 task 双向关联：task.evidenceRefs 记录 PR URL，PR description 包含 task_id
- **REQ-L3-004**:（应该）PR ready for review 时，自动触发 E3（diff 风险扫描）
- **REQ-L3-005**:（应该）PR merged 时，自动触发 E1（任务状态翻转）

### 非功能需求

- **REQ-L3-NFR-001**: Branch 命名规范，不含特殊字符，长度 ≤ 60 字符

## 3. 用户故事

```
作为工程师，认领任务后我不需要手动建 branch 和写 PR 描述，
系统已经帮我建好了，描述里有验收标准，我直接开始写代码。
验收：认领任务 → 5 分钟内 GitHub 出现对应 branch 和 draft PR。
```

## 4. 验收标准

- [ ] AC-L3-001: 认领任务后自动建 branch，命名含 task_id
- [ ] AC-L3-002: draft PR 描述包含 businessNote（业务语言）
- [ ] AC-L3-003: draft PR 描述包含 acceptance checklist（可勾选）
- [ ] AC-L3-004: task.evidenceRefs 包含该 PR 的 URL
- [ ] AC-L3-005: PR merged 后触发 E1（5 分钟内任务状态变 completed）

## 5. 技术方案

### PR 描述模板

```markdown
## 业务目标
{task.businessNote}

## 验收标准
{task.acceptance 的每条包成 - [ ] 格式}

## 依赖
{task.dependencies 列表，每项链接到对应 task}

## 关联
Task: {task.id}
Milestone: {task.milestoneId}
Requirements: {task.requirementRefs}
```

### CUE 接入点

```
改动: server/routes/assignmentRoutes.js
  - PATCH /api/assignments/:id（认领）→ 触发 createTaskBranch()

改动: server/services/githubApi.js
  - 新增 createBranchForTask(task, project)
  - 新增 createDraftPR(task, branch, project)

事件: assignment.claimed → bus.emit('task.branch.create')
      pr.merged → bus.emit('task.complete', { taskId })  → E1
      pr.opened_for_review → bus.emit('task.diff.scan')  → E3
```

## 6. 差距分析

| 能实现的 | 实现不了的 |
|---|---|
| Branch + draft PR 自动建立 | 工程师不看 PR 描述的问题（社会问题）|
| PR 描述从 task schema 生成 | 多人共同提交到同一 PR 的归因 |
| 双向关联 | — |

## 7. 实现笔记

> 待实现后更新。
