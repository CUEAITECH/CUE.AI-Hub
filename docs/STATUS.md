# CUE Hub — 当前状态

> 维护规则：每次里程碑完成或 daily-scan 后更新。AI PM 接管 E4 后自动刷新。  
> 最后更新：2026-06-03（手动）

---

## 当前里程碑

**Agentic SDLC Phase 1 — 闭环地基**

| 目标 | 状态 |
|---|---|
| SPEC-L2：Task schema v2（acceptance / dependencies / businessNote / 稳定 ID） | ⬜ 未开始 |
| SPEC-E1：commit/PR → 任务状态自动翻转 | ⬜ 未开始 |
| SPEC-E3：diff 风险 Block → 自动建修复任务 | ⬜ 未开始 |
| SPEC-L3：任务认领 → 自动建 branch + draft PR | ⬜ 未开始 |

预计工期：6–8 周（依据 feasibility spec）  
负责人：田家铭（架构主导）

---

## Spec 实现矩阵

| Spec | 标题 | Phase | 可实现度 | 实现状态 | 已有种子代码 |
|---|---|---|---|---|---|
| SPEC-L1 | 想法 → 澄清反问 → 标准 PRD | 2 | 85% | ⬜ 未开始 | 无 |
| **SPEC-L2** | PRD → 里程碑 + Task schema v2 | **1 ★** | 78% | ⬜ 未开始 | `docsManager.js` PARSE_SYSTEM_PROMPT（需升级）|
| **SPEC-L3** | 任务 → 自动建 branch + draft PR | **1 ★** | 90% | ⬜ 未开始 | `githubApi.js` createBranch / createDraftPR 已有 |
| SPEC-L4 | 实时监控（commit / diff / 缺口 / PR 还差什么）| 2 | 65% | ⬜ 未开始 | `semanticLinker` / `reviewer` / `riskEngine` |
| SPEC-L5 | Browser Agent 像人一样测试 | 3 | 48% | ⬜ 未开始 | `mcp__Claude_in_Chrome` 已连接 |
| **SPEC-E1** | commit/PR → 任务状态自动翻转 | **1 ★** | 80% | ⬜ 未开始 | `semanticLinker.commitTaskLinks`（24 条已实证）|
| SPEC-E2 | 测试结果 → 业务是否真实现 | 3 | 48% | ⬜ 未开始 | 依赖 L5 |
| **SPEC-E3** | diff 风险 → 阻断 / 新建修复任务 | **1 ★** | 83% | ⬜ 未开始 | `reviewer.js`（182 条 review 已工作）|
| SPEC-E4 | 完成情况 → 实时调整里程碑 | 2 | 65% | ⬜ 未开始 | 依赖 E1 + E3 |
| SPEC-E5 | 交付 → 下一轮迭代起点 | 3 | 80% | ⬜ 未开始 | `dailyBrief.js` |

★ = Phase 1 优先，先做这四条闭环最关键的边。

---

## 已交付里程碑

| # | 里程碑 | 完成时间 | 关键产出 |
|---|---|---|---|
| 9 | 多租户数据隔离 | 2026-06 | session → tenantId 全路由覆盖；writeStore 自动打戳；读隔离回归验证 |
| 8.1 | Agentic SDLC 文档架构 | 2026-06-03 | docs/specs/ + docs/vision/ + docs/architecture/ + docs/research/ 建立；10 个 SPEC 完成 |
| 8 | PR 流 + Webhook 实时同步 | 2026-05-21 | Webhook 驱动 PR 实时 upsert；PR-Agent sink；bypass 机制；`pulls` / `bypasses` store 集合 |
| 7.1 | Linear 风格边栏重设计 | 2026-05-21 | 边栏重设计；sys-config tab 合并；观察台全页显示 |
| 7 | PR 流全面切换 | 2026-05-20 | `pulls` 集合；PR 合规率接入健康度；企微作战包 PR 汇总；前端 #viewPulls |
| 6 | reviewer 架构合并（PR-Agent 风格）| 2026-05 | compliance 对照；issues 行号锚定；`apiQA.js` 删除；任务详情验收对照卡片 |
| 5 | 健康度算法改进 | 2026-05 | 几何平均聚合；DORA MTTR 第五维；权重调整 |
| 4 | 任务进度智能评估 | 2026-05 | API QA 自动评估（3 checkpoint）；进度可下降；`aiPromptTraces` 落库 |
| 3 | 企微写入工具 | 2026-05 | claim / standup / progress 三个写接口；模糊匹配任务 |
| 2 | 交互体验优化 | 2026-05 | 一键认领；AI 审阅人工待办队列；自动部署 GitHub Actions |
| 1 | 核心功能建设 | 2026-05 | GitHub 同步；AI Review；企微集成；晚会闭环；AI PM 初版 |

---

## 当前已知技术债（Phase 1 要修的）

| 问题 | 位置 | 症状 |
|---|---|---|
| `acceptance = description` 硬编码 | `docsManager.js:1094` | 任务验收标准直接复制描述，无意义 |
| Task ID 不稳定 | `docsManager.js:1140` `createId('task')` | 重新解析同一文档 → 新 ID → 已完成任务归零 |
| commitTaskLinks 不回写 store | `semanticLinker.js` | 语义关联生成后停留在分析层，任务状态不更新 |
| Block review 无下游动作 | `pullPipeline.js:306`（主路）/ `reviews.js:84`（次路） | PR-Agent Block 仅广播企微，不建修复任务、不阻断里程碑计入 |
| 认领任务无 branch/PR 自动创建 | `assignmentRoutes.js` | 工程师需手动建分支，PR body 无验收清单 |

---

## 追溯链健康度（自评）

```
vision ──✅──→ feasibility spec ──✅──→ specs (REQ / AC)
                                              │
                                              ↓ ← 断开
                                        Hub tasks（无 requirementRefs）
                                              │
                                              ↓ ← 断开
                                        commits（无 task_id 规范）
                                              │
                                              ↓ ← 断开
                                        task.status（手动点，易归零）
```

Phase 1 完成后，中间三段断开的链路将被 SPEC-L2 / SPEC-E1 / SPEC-L3 焊上。
