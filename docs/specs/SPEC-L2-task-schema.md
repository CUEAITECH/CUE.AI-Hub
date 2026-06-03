---
id: SPEC-L2
title: "L2 — PRD → 里程碑 + 任务 schema v2"
status: draft
type: layer
index: 2
fidelity: 78%
open-source-basis:
  - Taskmaster/claude-task-master (dependencies/acceptance/expand)
  - Backlog.md (git-native task format with AC)
cue-seed:
  - server/services/docsManager.js (parsePhasesFromDocs:398, selectDailyDocTasks:534)
  - server/services/planner.js
dependencies: []
effort-weeks: 3
phase: 1
---

# SPEC-L2：PRD → 里程碑 + 任务 schema v2

## 1. 目标

> 把一份 PRD 解析成三层结构：里程碑（Milestone）→ 任务（Task）→ 子任务（Subtask）。每条任务带验收标准、依赖关系、业务/技术双视图。彻底替换当前"扁平碎片"输出。

**当前问题**：PARSE_SYSTEM_PROMPT 输出 schema 无 acceptance、无 dependency；docsManager:1094 硬编码 `acceptance = description`；phases:0（里程碑层完全丢失）。

## 2. 需求

### 功能需求

- **REQ-L2-001**:（必须）解析 PRD 产出三层：Milestone → Task → Subtask
- **REQ-L2-002**:（必须）每条 Task 必须有独立的 `acceptance` 字段（不得等于 `description`）
- **REQ-L2-003**:（必须）每条 Task 必须有 `dependencies: [taskId]` 字段
- **REQ-L2-004**:（必须）每条 Task 必须有 `businessNote`（业务语言，非技术人员可读）
- **REQ-L2-005**:（必须）每条 Task 必须有稳定 `id`，重新解析不得更换已存在任务的 id
- **REQ-L2-006**:（应该）每条 Task 有 `milestoneId` 关联里程碑
- **REQ-L2-007**:（应该）每条 Task 有 `requirementRefs: [REQ-xxx]` 追溯到来源需求
- **REQ-L2-008**:（应该）支持 `expand`：把复杂 Task 展开为子任务列表

### 非功能需求

- **REQ-L2-NFR-001**: acceptance ≠ description 的比例 ≥ 95%（当前 37%）
- **REQ-L2-NFR-002**: 重新解析同一 PRD，已存在任务的 id 保持不变（幂等）

## 3. 用户故事

```
作为业务负责人，我看到任务时能用人话理解它（businessNote），
不需要懂技术术语。
验收：每条任务有一句"用户能 XX" 格式的业务说明。
```

```
作为工程师，我知道一个任务做完的标准是什么，
不是又复制了一遍描述。
验收：acceptance 是可测量的完成条件，与 description 不同。
```

## 4. 验收标准

- [ ] AC-L2-001: 解析 PRD 后 `phases` 数组非空（里程碑层存在）
- [ ] AC-L2-002: 随机抽取 10 条任务，acceptance ≠ description 的占比 ≥ 9/10
- [ ] AC-L2-003: 随机抽取 10 条任务，businessNote 用非技术语言描述业务价值
- [ ] AC-L2-004: 重新同步同一文档，已完成任务 ID 不变、状态不被重置
- [ ] AC-L2-005: 任务 A 依赖任务 B 时，`A.dependencies` 包含 B 的 id

## 5. 技术方案

### 新 Task Schema（v2）

```json
{
  "id": "task_xxx_yyy",           // 稳定 ID，不随重解析变化
  "milestoneId": "m1",            // 归属里程碑
  "title": "实现学生端 TRTC 进房", // ≤ 20 字
  "businessNote": "学生能通过课堂码加入老师的课堂并开麦说话", // 业务语言
  "description": "接入 trtc-sdk-v5，调用 enterRoom + startLocalAudio", // 技术细节
  "acceptance": "学生端进入课堂后，TRTC 控制台显示该学生已进房，本地麦克风静音按钮可用",
  "dependencies": ["task_aaa_bbb"], // 依赖的 task id
  "requirementRefs": ["REQ-L2-001"], // 追溯来源需求
  "owner": "林世棋",
  "suggestedOwner": "林世棋",
  "priority": "P0",
  "status": "pending",
  "dueDate": "",
  "sourceDoc": "docs/当前开发计划.md",
  "evidenceRefs": [],             // E1 写入：commit/PR id
  "tenantId": "default"
}
```

### Milestone Schema

```json
{
  "id": "m1",
  "title": "M1：教师端真实进房",
  "acceptance": "至少一个教师端能进入 TRTC 房间并产生音频",
  "status": "in_progress",
  "taskIds": ["task_xxx_yyy", "..."]
}
```

### 开源组件借鉴

| 借谁 | 借什么 | 微调点 |
|---|---|---|
| Taskmaster | PRD parse prompt 结构；`dependencies` 字段；幂等 ID 设计（按标题 hash 生成，不用 Date.now()） | 加中文支持；加 businessNote |
| Backlog.md | 每条 task 的 acceptance criteria 格式 | 改为 JSON 而非 markdown |

### CUE 接入点

```
改动文件: server/services/docsManager.js

1. 替换 PARSE_SYSTEM_PROMPT（181行）的输出 schema
   → 加入 acceptance / dependencies / businessNote / milestoneId / requirementRefs

2. 删除 docsManager.js:1094 的 acceptance = description 硬编码

3. 修复 parsePhasesFromDocs 结果持久化
   → 确保 phases 写入 store（当前返回但未存储）

4. 修改 selectDailyDocTasks 的幂等 ID 逻辑
   → 新任务：按 (sourceDoc + title).hash 生成稳定 ID
   → 已有任务：复用原 ID，只更新 metadata
```

## 6. 差距分析

| 能实现的 | 实现不了的 | 硬上限 |
|---|---|---|
| 三层结构（里程碑/任务/子任务）| 隐式依赖自动检测 | LLM 约 70% 召回隐式依赖 |
| 验收标准独立生成 | 验收标准可测性保证 | 需要工程师 review |
| 业务/技术双视图 | 双视图的一致性维护 | 中文 LLM 输出不稳定 |
| 幂等 ID | 跨文档合并去重 | 需要相似度阈值调参 |

## 7. 实现笔记

> 待实现后更新。
