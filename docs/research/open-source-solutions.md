# 开源方案参考

> CUE 的 Agentic SDLC 不自研基础能力。这里记录每个开源项目"借什么 / 不借什么"。

---

## Taskmaster（claude-task-master）

**仓库**: eyaltoledano/claude-task-master  
**定位**: PRD → 带依赖/验收/ID 的任务树，供 AI coding agent 用

**借鉴**:
- `parse-prd` 的输出 schema：dependencies / acceptance / complexity / subtasks
- `update` 命令机制：偏离计划时只修正下游未完成任务（CUE 的 E4 纠偏直接参考）
- `expand` 命令：把复杂任务展开为子任务（CUE 的 ② 层分解）
- 幂等 ID 设计思路

**不借鉴**:
- 整体架构（它是单人单机工具，无团队协作）
- 与 Cursor/Windsurf 的集成（CUE 有自己的前端）
- tasks.json 文件存储格式（CUE 用 SQLite + JSON store）

---

## Backlog.md

**仓库**: MrLesk/Backlog.md  
**定位**: git/markdown 原生任务管理，为 AI agent 设计的任务格式

**借鉴**:
- 每条任务的 markdown 结构（acceptance criteria 区块格式）
- "任务是 git 仓库的一等公民"的设计哲学
- Kanban 状态流转设计

**不借鉴**:
- markdown 文件存储（CUE 用数据库）
- 无团队/多租户概念

---

## GitHub Spec Kit

**仓库**: github/spec-kit  
**定位**: Spec-Driven Development 工具套件（GitHub 官方）

**借鉴**:
- `/specify` 流程：自由文本输入 → 澄清问题 → 标准 spec（CUE 的 ① 层）
- PRD 模板字段：goal / user-stories / scope / non-goals / acceptance / risks
- "spec 作为唯一真相源"的工作流理念

**不借鉴**:
- CLI 工具本身（CUE 有自己的 Web UI）
- 与 GitHub Copilot 的深度集成

---

## Agentic Project Management（APM）

**仓库**: sdi2200262/agentic-project-management  
**定位**: Planner 读代码库 → 产出三份规划文档 → Manager 协调执行

**借鉴**:
- **Planner 读代码库的机制**：在生成计划前遍历文件树 + 读关键文件（CUE 的 ② 差距分析层，当前完全缺失）
- "代码现状 vs 规划目标"的对比分析 prompt

**不借鉴**:
- 整体多 agent 架构（APM 是 local 单仓库，CUE 管理多项目）

---

## Skyvern

**仓库**: Skyvern-AI/skyvern  
**定位**: 自然语言驱动的浏览器自动化，像人一样点击网页

**借鉴**:
- 截图 → Vision LLM 识别 → 操作的核心机制
- 任务描述格式（用自然语言描述要完成的操作）

**不借鉴**:
- 音视频测试（Skyvern 也做不到）

**当前可实现度**: 75-80%（标准 Web 流程）/ 8-12%（音视频）

---

## TraceLLM

**论文**: arXiv 2602.01253（2026）  
**定位**: 需求 ↔ 代码的语义追溯，F2 分数 SOTA

**借鉴**:
- 语义匹配 prompt 设计：commit summary ↔ requirement sentence
- 双向追溯：requirement → code（E1 正向）；code → requirement（audit 反向）

**用于 CUE**: SPEC-E1 的语义匹配层。

---

## 选型总结

| 层/边 | 主用方案 | 备用方案 |
|---|---|---|
| ① 澄清→PRD | Spec Kit 工作流 | 自写澄清 prompt |
| ② 任务 schema | Taskmaster schema | Backlog.md 格式 |
| ③ 自动 PR | GitHub API（已有）| - |
| E1 commit 追溯 | TraceLLM 语义 | 显式 task ID 双保险 |
| E2 浏览器测试 | Skyvern | browser-use / Stagehand |
| E3 diff 风险 | CUE 自有 reviewer.js | - |
| E4 纠偏 | Taskmaster `update` 机制 | 闭环重规划论文 |
| ② 差距分析 | APM Planner 机制 | 手动 gap analysis |
