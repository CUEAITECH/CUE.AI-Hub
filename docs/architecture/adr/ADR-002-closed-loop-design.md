# ADR-002: 闭环设计 — 从开环重解析到状态触发增量更新

**日期**: 2026-06-03  
**状态**: accepted  
**决策人**: 田家铭

---

## 背景

当前 sync-docs 是**开环全量重解析**：每次运行都重新生成所有任务，用新 ID 覆盖旧任务。

5/31 事件证明了这个设计的灾难性：重解析冲掉了 5/3-5/22 期间所有真实完成的任务（24 个 task ID 全部丢失，与当前 hub 交集为 0）。

学术上，这是被反复记录的 "Open-loop execution" 失败模式（LLM-Based Multi-Agent for SE, TOSEM 2025）。

## 决策

改为**状态触发的增量更新**（State-triggered incremental update），原则：

1. **已存在任务不重建**：按 `hash(sourceDoc + title)` 匹配，已有 ID 的任务只更新 metadata（priority / dueDate / description），不换 ID、不重置 status
2. **完成的任务不重导入**：`completedTitles` 过滤（REQ-E1-005），有 commit 覆盖的任务视为完成
3. **新任务才创建新 ID**：只有 hash 在 store 里找不到对应任务时，才建新条目
4. **触发时机**：PR merged webhook 触发一次语义链接 + 状态回写，而非定时全量重跑

## 借鉴来源

- Taskmaster `update` 命令机制：偏离计划时只修正下游未完成任务
- Closed-loop replanning（arXiv 2504.16563）：状态触发，不是定时全量

## 影响

- `server/services/docsManager.js`：`selectDailyDocTasks` 增量逻辑
- `server/services/semanticLinker.js`：触发状态回写
- `server/routes/webhookRoutes.js`：PR merged → 触发 semanticLinker
- 移除 `server/cron/index.js` 里的定时全量 sync-docs（改为事件驱动）
