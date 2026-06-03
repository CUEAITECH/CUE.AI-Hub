# ADR-001: Task Schema v2

**日期**: 2026-06-03  
**状态**: accepted  
**决策人**: 田家铭

---

## 背景

当前 Task schema 只有 `title / owner / priority / description / status` 五个字段。

经数据诊断（2026-06-03）：
- 17/27 任务 `acceptance === description`（63%）
- 26/27 任务 `linkedRefs` 为空
- `phases: 0`（里程碑层完全丢失）
- AI PM 重解析会冲掉所有已完成任务（5/31 事件）

根因：PARSE_SYSTEM_PROMPT 输出 schema 设计时就没有 acceptance / dependency / milestoneId 字段，导入代码 docsManager.js:1094 硬编码 `acceptance = description`。

## 决策

采用 Task Schema v2，新增以下字段：

| 字段 | 类型 | 用途 |
|---|---|---|
| `milestoneId` | string | 归属里程碑 |
| `businessNote` | string | 业务语言描述，非技术人员可读 |
| `acceptance` | string | 独立验收标准，不得等于 description |
| `dependencies` | string[] | 依赖的 task id 列表 |
| `requirementRefs` | string[] | 追溯来源需求 REQ-xxx |
| `evidenceRefs` | string[] | E1 写入的 commit/PR 证据 |

同时：ID 生成策略从 `Date.now().toString(36)` 改为 `hash(sourceDoc + title)` 保证幂等。

## 考虑过的替代方案

**方案 A：不改 schema，只修 prompt**
- 结：成本低
- 否：prompt 无法弥补 schema 字段缺失，1094 行硬编码仍在

**方案 B：完全采用 Taskmaster 的 tasks.json**
- 结：字段更完整
- 否：与 CUE 现有 store / v2 SQLite 层耦合复杂，迁移成本高；且 Taskmaster 无 businessNote

**方案 C（采用）：在现有 schema 上增量扩展**
- 结：兼容现有数据；businessNote 是 CUE 独有的差异化字段
- 否：需要数据迁移（旧任务 acceptance 字段补填）

## 影响

- `server/services/docsManager.js`：PARSE_SYSTEM_PROMPT + 导入逻辑
- `server/services/planner.js`：同步更新 planner 的任务生成
- `server/store.js`：`migrateStore` 新增 v2 task 字段默认值
- 前端：task detail 面板增加 businessNote / acceptance / dependencies 展示
