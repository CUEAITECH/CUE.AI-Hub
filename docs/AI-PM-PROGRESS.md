# AI 任务推荐功能 — 实施进度看板

> **实时维护**。每个 Phase / Task 完成后立即更新此文档，避免上下文丢失导致重复工作或冲突。

**Sprint：** 1.5a（thin slice）
**Spec：** [docs/superpowers/specs/2026-05-18-ai-task-recommendation-design.md](./superpowers/specs/2026-05-18-ai-task-recommendation-design.md)
**Branch：** `claude/quirky-moser-d4bda9`
**当前状态：** 🟡 Phase 1 完成（数据模型已落库），等待 Phase 2 推荐引擎实施
**最后更新：** 2026-05-18

---

## Phase 进度总览

| # | Phase | 状态 | 提交 SHA | 关键产出 |
|---|------|------|---------|---------|
| 0 | spec & plan | 🟡 进行中 | - | spec + implementation plan |
| 1 | 数据模型 + migrateStore | ✅ 完成 | `612452b` | store.dailyTaskSuggestions + aiPromptTraces, assignment 加字段 |
| 2 | 推荐引擎 service | ⚪ 待开始 | - | server/services/dailyTaskSuggester.js |
| 3 | API endpoints | ⚪ 待开始 | - | GET/POST recommendations 3 个 |
| 4 | 调度器接入 17:45 | ⚪ 待开始 | - | scheduler.js 加生成步 |
| 5 | 前端 panel 改造 | ⚪ 待开始 | - | index.html + src/app.js |
| 6 | E2E smoke 验证 | ⚪ 待开始 | - | 烟雾测试通过 |

图例：⚪ 待开始 / 🟡 进行中 / ✅ 完成 / ❌ 阻塞

---

## 已确认的关键设计决策

(摘自 brainstorming 全程，每条都有 spec 章节锚)

| # | 决策 | 来源 |
|---|------|------|
| Q1 | UI 入口：改造现有 meeting tab + 概览页 banner（banner 留 Sprint 1.5c）| spec §5 |
| Q2 | 可见性：默认个人，可切全员（全员 toggle 留 1.5c）| spec §5 + §7 |
| Q3 | 推荐来源：现有任务池筛选，AI 不创建新任务 | spec §4.2 |
| Q4 | 生成时机：17:45 自动 + 手动刷新按钮 | spec §3.2, §4.5 |
| Q5 | 兜底：✓/换/看全部/今天没任务（thin slice 只做 ✓）| spec §7 |
| Q6 | 数据模型：新 `dailyTaskSuggestions`，接受后转 assignment | spec §2 |
| Q7 | LLM 调用方式：独立调用每用户 1 次，prompt cache 命中 system | spec §4.3 |
| Q8 | superseded 排除：同 forDate 内排除，跨日 reset | spec §2.4 |
| Q9 | 任务冲突：UI 灰态 + 409 兜底，不自动补位 | spec §3.3 |
| Q10 | 实施范围：thin slice 6 Phase（不含 swap/看全部/全员/banner/WeCom）| spec §7 |
| Q11 | LLM 失败：fail loud，不做规则降级（保 PMF 数据纯净度）| spec §4.4 |
| Q12 | 加 `store.aiPromptTraces` 落 LLM 输入/输出日志，解锁 prompt 迭代 | spec §2.5, §4.5, §8.2 |

---

## 进行中 / 待办

- [ ] User review spec
- [ ] Invoke writing-plans skill → 产出 implementation plan
- [ ] Phase 1 实施

---

## 决策日志（implementer 遇到分歧记这里）

(空，待 implementer 添加)

---

## 已知 issues / 偏离设计的地方

(空，待 implementer 添加)

---

## PMF 指标看板（功能上线后开始收集）

| 指标 | 当前值 | 目标 |
|------|--------|------|
| 接受率 | - | > 60% |
| 刷新率 | - | < 30% |
| 候选池健康 | - | 平均 ≥ 5 个 |
| 接受后完成率 | - | > 70% |
| 撤销率 | - | < 10% |

---

## 后续 Sprint 蓝图

- **1.5b**（看反馈）：换一个 / 看全部 / 今天没任务 三出口
- **1.5c**（看反馈）：全员视图 + 概览 banner + WeCom 适配 + 周报推送
