# Data Models — CUE Agentic SDLC

所有核心数据结构的权威定义。代码实现以此为准。

---

## Task v2

```typescript
interface Task {
  // 身份（稳定，不随重解析变化）
  id: string                  // hash(sourceDoc + title)，幂等
  tenantId: string
  projectId: string

  // 层级归属
  milestoneId?: string        // 归属里程碑 (新增)
  parentTaskId?: string       // 父任务（子任务时有值）

  // 内容
  title: string               // ≤ 20 字，简洁
  businessNote: string        // 业务语言描述，非技术人员可读 (新增)
  description: string         // 技术细节描述
  acceptance: string          // 独立验收标准，必须 ≠ description (修复)

  // 计划
  priority: 'P0' | 'P1' | 'P2'
  dueDate?: string            // ISO date
  dependencies: string[]      // 依赖的 task id 列表 (新增)
  requirementRefs: string[]   // 追溯来源需求 REQ-xxx (新增)

  // 来源
  sourceDoc?: string          // 来源文档路径
  type?: 'feature' | 'fix' | 'chore'  // fix = E3 自动建的修复任务

  // 状态
  owner: string
  suggestedOwner?: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  blocked?: boolean           // E3 设置

  // 证据（E1/E2/E3 写入）
  evidenceRefs: string[]      // commit SHA / PR URL (新增)
  e2Status?: 'not-tested' | 'verified' | 'failed' | 'needs-review' | 'manual-required'

  // 元数据
  createdAt: string
  updatedAt: string
}
```

---

## Milestone

```typescript
interface Milestone {
  id: string                  // 稳定 ID
  projectId: string
  tenantId: string

  title: string               // ≤ 30 字
  acceptance: string          // 里程碑验收标准（整体）
  goal: string                // 一句话目标

  status: 'not-started' | 'in-progress' | 'completed' | 'blocked'
  dueDate?: string

  taskIds: string[]           // 归属任务列表
  completionPct: number       // 0-100，由 E1 信号动态计算

  // 进度追踪
  e1CompletedCount: number    // E1 确认完成的任务数
  e2VerifiedCount: number     // E2 验证通过的任务数
  blockedCount: number        // E3 阻断的任务数

  createdAt: string
  updatedAt: string
}
```

---

## PRD

```typescript
interface PRD {
  id: string                  // prd_xxx
  projectId: string
  tenantId: string

  title: string
  version: string             // semver
  status: 'draft' | 'active' | 'archived'

  // 内容（来自 L1 澄清输出）
  goal: string                // 一句话目标
  userStories: UserStory[]
  scope: string[]             // 范围内
  nonGoals: string[]          // 明确不做
  acceptance: string[]        // 整体验收标准（REQ 级别）
  risks: string[]

  // 追溯
  milestoneIds: string[]      // 从此 PRD 派生的里程碑
  sourceInput: string         // 原始用户输入

  createdAt: string
  updatedAt: string
}

interface UserStory {
  id: string                  // US-001 格式
  as: string                  // 角色
  want: string                // 操作
  so: string                  // 收益
  acceptance: string          // 可测量完成条件
}
```

---

## TestRun（L5 / E2）

```typescript
interface TestRun {
  id: string
  taskId: string
  milestoneId?: string
  tenantId: string

  triggeredAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed' | 'timeout'

  acResults: ACTestResult[]
  overallVerdict: 'pass' | 'fail' | 'inconclusive' | 'manual-only'

  cost: number                // USD
  durationSeconds: number
  tool: 'skyvern' | 'browser-use' | 'stagehand' | 'manual'
}

interface ACTestResult {
  acId: string                // 对应 SPEC 或 task 的 AC-xxx
  status: 'pass' | 'fail' | 'inconclusive' | 'manual-only'
  evidence?: string           // screenshot URL
  reason?: string             // 为什么 inconclusive / fail
}
```

---

## GapAnalysis（L4-c）

```typescript
interface GapAnalysis {
  projectId: string
  tenantId: string
  analyzedAt: string

  items: GapItem[]
  summary: {
    implemented: number
    partial: number
    missing: number
  }
}

interface GapItem {
  requirementRef: string      // REQ-xxx 或 AC-xxx
  description: string
  status: 'implemented' | 'partial' | 'missing'
  evidence?: string           // 文件路径 / 函数名
  suggestedTaskTitle?: string // missing 时自动建议任务
}
```

---

## Store 迁移（migrateStore 新增字段）

```javascript
// server/store.js migrateStore() 新增
if (!store.prds)         store.prds = [];
if (!store.milestones)   store.milestones = [];
if (!store.testRuns)     store.testRuns = [];
if (!store.gapAnalysis)  store.gapAnalysis = {};
if (!store.manualTestQueue) store.manualTestQueue = [];

// Task 字段补全（已有任务的迁移）
(store.tasks || []).forEach(t => {
  if (!t.milestoneId)      t.milestoneId = null;
  if (!t.businessNote)     t.businessNote = t.description || '';
  if (!t.dependencies)     t.dependencies = [];
  if (!t.requirementRefs)  t.requirementRefs = [];
  if (!t.evidenceRefs)     t.evidenceRefs = [];
  if (!t.e2Status)         t.e2Status = 'not-tested';
  // 修复 acceptance = description 的历史数据
  if (t.acceptance === t.description) t.acceptance = '';
});
```
