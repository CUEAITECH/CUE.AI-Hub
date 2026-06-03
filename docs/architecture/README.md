# Architecture

技术决策文档。回答"系统怎么构成、为什么这么构成"。

## 文档列表

| 文档 | 内容 |
|---|---|
| [system-overview.md](system-overview.md) | 5层+5边架构图、模块边界 |
| [data-models.md](data-models.md) | Task v2 / Milestone / PRD 等核心数据结构 |
| [adr/](adr/) | 架构决策记录（Architecture Decision Records） |

## ADR 索引

| ADR | 标题 | 状态 |
|---|---|---|
| [ADR-001](adr/ADR-001-task-schema-v2.md) | Task Schema v2：加验收/依赖/业务视图/稳定 ID | accepted |
| [ADR-002](adr/ADR-002-closed-loop-design.md) | 闭环设计：从开环重解析到状态触发增量更新 | accepted |
| [ADR-003](adr/ADR-003-browser-agent-choice.md) | Browser Agent 选型：Skyvern vs browser-use vs Stagehand | draft |
