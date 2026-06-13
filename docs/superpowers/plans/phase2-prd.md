# CUE Project Hub — Phase 2 PRD

## 背景

Phase 1 已完成 Agentic SDLC 的骨架（L2 task schema + L3 PR automation + E1 commit tracking + E3 diff risk）。
Phase 2 目标：让闭环真正成形——需求澄清、业务缺口分析、自动纠偏。

## 目标

1. **L1 澄清反问**：需求文档模糊时，AI 自动生成确认问题推回给 PM，防止歧义进入开发
2. **L4-c 业务缺口**：每个 PR 合并后，对比 acceptance criteria 和实际 diff，输出"还差什么"报告
3. **E4 纠偏重规划**：任务完成/阻断信号触发，自动调整下游未完成任务的优先级和排期（Taskmaster update 机制）
4. **工具链完善**：Spec Kit dogfood（hub 管自己）、TraceLLM 前端展示、APM dashboard

## 功能需求

### REQ-1: L1 需求澄清模块
- 在 `POST /sync-docs` 解析阶段，对缺少 acceptance 或 businessNote 的任务，自动生成 2-3 个澄清问题
- 通过企微推送给关联 owner，附上问题列表和文档链接
- owner 回复后，通过 `PATCH /api/tasks/:id` 更新 acceptance
- 澄清问题存入 `store.clarifications[taskId]`，状态：pending / answered / skipped

### REQ-2: L4-c PR 业务缺口分析
- PR merged 事件触发（复用 E1 webhook）
- 从 PR body 提取验收清单（## 验收标准 section）
- 获取 PR diff（复用 diffAnalyzer.js）
- LLM 比对 diff vs acceptance criteria，输出缺口报告：{ covered: [...], missing: [...], riskLevel }
- 缺口报告写入 `store.gapAnalyses[taskId]`，通过企微推送
- `GET /v2/gap-analyses` 端点供前端消费

### REQ-3: E4 纠偏重规划
- 触发时机：E1 自动翻 completed 后、E3 生成修复任务后
- 从 Taskmaster 借鉴 `update` 算法：只修改 blocked=true 或 status=pending 的下游任务
- 对下游任务：提高 priority、调整 dueDate、添加 blockerNote
- 把调整结果写入 store，并推送企微摘要（"XX 任务阻断，下游 N 个任务已重新排期"）
- `POST /api/tasks/replan` 端点，可手动触发

### REQ-4: Spec Kit dogfood
- 在 hub 的 projects 里配置 `CUEAITECH/CUE.AI-Hub` 为一个 project
- `POST /projects/:id/daily-scan` 可作用于 hub 自身，解析 docs/specs/*.md 为任务
- 这样 hub 用自己的 AI PM 功能管理自己的开发工作

### REQ-5: TraceLLM 前端展示
- 前端新增"观察台 > LLM 调用"标签页
- 展示今日调用统计：总次数、按 purpose 分组、缓存命中率、平均 latency、总费用
- 展示最近 20 条调用记录（purpose/model/latency/tokens/cost）
- 数据来源：`GET /v2/observability/llm`（已有）

### REQ-6: APM HTTP Dashboard
- 前端新增"观察台 > HTTP 指标"标签页
- 展示：总请求数、错误率、Top 10 慢路由（P95）、Top 10 高频路由
- 数据来源：`GET /v2/observability/http`（已有）

## 非功能需求

- L1 澄清问题生成时间 < 5s
- L4-c gap 分析在 PR merged 后 2 分钟内完成
- E4 纠偏不影响已完成任务（只修改 pending/blocked 的下游任务）
- 所有 LLM 调用支持降级（无 key 时跳过，不阻断主流程）

## 验收标准

- [ ] L1：sync-docs 遇到缺 acceptance 任务，企微收到澄清问题推送
- [ ] L4-c：合并一个带验收清单的 PR，5 分钟内 hub 展示缺口报告
- [ ] E4：制造一个 Block review，验证下游任务 priority 自动变为 P0
- [ ] Spec Kit：hub 能 parse 自己的 docs/specs/SPEC-L1.md 并在任务板看到 L1 的任务
- [ ] TraceLLM 前端：观察台能看到今日 LLM 调用费用和 P95 latency
- [ ] APM 前端：观察台能看到 /v2/app/state 的调用次数和 P95 耗时
