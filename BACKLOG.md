# CUE Project Hub — Backlog

> 单一可信来源：所有待做事项按 Phase 组织。✅ = 已完成，🔶 = 进行中，⬜ = 待开始。
> Taskmaster tasks.json 是机器可读版本，本文件是人工可读摘要。
> 最后更新：2026-06-11

---

## Phase 1：已完成 ✅

| 编号 | 内容 | 层/边 |
|------|------|------|
| T1 | store.js 迁移 — Task v2 新字段（milestones/prds/businessNote/dependencies/evidenceRefs） | L2 |
| T2 | PARSE_SYSTEM_PROMPT 升级 — 输出 Task v2 schema，acceptance≠description | L2 |
| T3 | stableTaskId (djb2) — 幂等 ID，重解析不归零 | L2 |
| T4 | selectDailyDocTasks — commit 覆盖任务加入 completedTitles，防重导入 | E1 |
| T5 | applyCommitLinksToTasks — confidence≥0.75 自动翻 completed | E1 |
| T6 | webhookRoutes — PR merged 触发 refreshAnalysisIntoStore | E1 |
| T7 | reviewTaskLinker.js — Block/Escalate → 建修复任务 + task.blocked | E3 |
| T8 | pullPipeline.js — PR-Agent 主路接线 E3 | E3 |
| T9 | githubApi.js — buildTaskPRBody + createTaskBranchAndPR | L3 |
| T10 | assignmentRoutes — 任务指派触发建 branch + draft PR | L3 |
| T11 | Task Contract 镜像层 — `.hub/{taskId}.md` YAML frontmatter | L3 |
| T12 | Prompt-as-Data — system prompt 外部化到 server/prompts/*.json | L2 |
| T13 | 依赖图 heal 管线 — parseDocsForTasks 入库前自动修复标题依赖 | L2 |
| T14 | 测试套件可靠性 — 消除 pino worker thread / SQLite 冷启动挂起 | infra |
| T15 | E3 次路修复 — reviews.js Block/Escalate 接入 handleReviewOutcome | E3 |
| T16 | buildMilestoneMetrics — completionPct/blockedCount 动态计算接入 /api/state | L2 |
| T17 | POST /api/tasks/:id/expand — LLM 子任务展开（REQ-L2-008） | L2 |
| T18 | 多租户隔离 — 全路由 tenantId + updateStore 写隔离守卫 | infra |

---

## 遗留 Gap（Phase 1 补丁，小件）⬜

| # | 内容 | 优先级 | 参考 |
|---|------|--------|------|
| G1 | ADR-002：cron 定时 sync-docs → 纯 PR-merged 事件驱动 | P1 | ADR-002 |
| G2 | AC-E1-004：假阳性 < 5% 自动化测试（20次采样验收） | P2 | SPEC-E1 |
| G3 | task.completedBy = 'e1' 字段 — 让 milestoneMetrics.e1CompletedCount 真正有值 | P2 | SPEC-L2 |
| G4 | Skyvern E2E：安装 Skyvern 服务，接入 hub UI 冒烟测试 | P3 | SPEC-E2 |

---

## Phase 2：闭环成形（12-16 周）⬜

> 目标：L1 澄清反问 + L4-c 缺口分析 + E4 纠偏/重规划

| # | 内容 | 层/边 | 工期估算 | 依赖 |
|---|------|------|---------|------|
| P2-1 | **L1 澄清反问**：需求模糊时自动生成确认问题，推回给 PM | L1 | 2-3 周 | — |
| P2-2 | **L4-c 业务缺口静态版**：PR diff + AC → LLM checklist 比对，输出缺口报告 | L4 | 4-6 周 | E3 |
| P2-3 | **E4 纠偏**：完成信号 (E1/E3) 触发 Taskmaster-style `update`，只修正下游未完成任务 | E4 | 5-8 周 | E1+E3 |
| P2-4 | **多模型路由**：低频精准用 gpt-5.5，高频廉价用 gpt-5.4-mini，规则引擎兜底 | infra | 1 周 | — |
| P2-5 | **Spec Kit dogfood**：hub 自身 `POST /daily-scan` 指向 `CUEAITECH/CUE.AI-Hub`，AI PM 管理自己的开发任务 | infra | 0.5 周 | — |
| P2-6 | **APM dashboard**：`GET /v2/observability/http` 前端可视化（请求数/错误率/P95） | infra | 1 周 | — |
| P2-7 | **TraceLLM 前端**：`GET /v2/observability/llm` 已有数据，补充前端 trace 展示页 | infra | 1 周 | — |

---

## Phase 3：护城河（16-24 周）⬜

> 目标：E2 browser agent 测试 + E5 迭代学习

| # | 内容 | 层/边 | 工期估算 | 依赖 |
|---|------|------|---------|------|
| P3-1 | **E2 Browser 测试**：Skyvern 接入，自动验证 hub UI 关键路径（登录/任务板/晚会报告） | E2 | 6-10 周 | Skyvern 部署 |
| P3-2 | **E5 迭代学习**：outcome 向量记忆 + in-context learning，历史 review 结果影响下次规划 | E5 | 10-14 周 | E2 |
| P3-3 | **L5 Browser Agent**：像人一样操作 hub，自动填写任务/触发晚会/生成报告 | L5 | 8-12 周 | E2 |
| P3-4 | **持续学习**：权重动态调整（低优先级，等 in-context 版成熟后评估） | E5+ | TBD | P3-2 |

---

## 工具接入状态

| 工具 | 状态 | 说明 |
|------|------|------|
| **Taskmaster** | ✅ 已接通 | MCP 连接，`.taskmaster/tasks.json` 同步，Phase 2 任务待 `parse_prd` 入库 |
| **Backlog.md** | ✅ 本文件 | Phase 1 全 done，Phase 2/3 结构化 |
| **TraceLLM** | ✅ 已内置 | `llm_calls` 表：latency/tokens/cost/prompt_hash，`GET /v2/observability/llm` 可查 |
| **APM** | ✅ 刚接入 | `server/services/apm.js` middleware，`GET /v2/observability/http` 暴露 HTTP 指标 |
| **Spec Kit** | ⬜ P2-5 | 配置 hub 自身为 project，`POST /daily-scan` 指向自己 |
| **Skyvern** | ⬜ P3-1 | 需安装 Skyvern 服务（Python + Playwright），接入 E2 browser 测试 |
