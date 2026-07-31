---
id: SPEC-L4c
title: "L4-c — PR 业务缺口分析（acceptance ↔ diff 对账）"
status: implemented
type: layer
index: L4-c
fidelity: 70%
open-source-basis:
  # 主依据（任务同款：LLM 判断「代码改动是否满足自然语言需求」）
  - "Are LLMs Reliable Code Reviewers? Systematic Overcorrection in Requirement Conformance Judgement (arXiv:2603.00539, 2026) — 开源 github.com/HollinJ3177/Are-LLMs-Reliable-Code-Reviewers-..."
  - "Enhancing PR Reviews: Detecting Inconsistencies Between Issues and Pull Requests (FORGE 2025) — exact/missing/tangling/both 分类法"
  # 范式背景（prompt 工程，但任务是文档↔文档，非代码）
  - "TraceLLM: Prompt Engineering for Requirements Traceability (arXiv:2602.01253, 2026) — 仅借 LLM-as-judge + 角色/显式关系/结构化输出范式，其任务为文档制品配对，不含 PR diff"
basis-note: >
  T13 解决的是 CUE 自有问题「PR diff ↔ acceptance criteria 覆盖度」。该具体场景未被上述任一论文直接验证。
  详见 §7 相关工作与依据谱系。早期把本场景误记为「TraceLLM ④-d」属错误归因，已在 docs/research/llm4re-survey.md 更正。
cue-seed:
  - server/services/githubApi.js (fetchPRDiff 已有)
  - server/services/claude.js (callClaude / parseJsonOutput 已有)
  - server/routes/webhookRoutes.js (PR merged 块，E1 旁边接线)
  - server/services/reviewTaskLinker.js (E3 同类事件驱动模式参考)
dependencies:
  - SPEC-L2
  - SPEC-L3
  - SPEC-E1
effort-weeks: 1
phase: 2
---

# SPEC-L4c：PR 业务缺口分析

## 1. 目标

> PR merged 后，用 LLM **一次性比对**「任务 acceptance criteria」↔「PR diff」，输出哪些验收点已覆盖（covered）、哪些缺失（missing）、整体风险等级，写入 `store.gapAnalyses`，供前端/接口读取。

回答一个 E3 回答不了的问题：**这个 PR 真的把任务做完了吗？** E3 看 diff 的代码风险（Block/Escalate），L4-c 看 diff 对**业务验收点**的覆盖度。两者并排，都是 PR merged 的 fire-and-forget 下游。

**边界（MVP）**：只做「acceptance 文本 ↔ diff 文本」的一次性 LLM 比对，**不读代码、不跑 ReAct**。抓「死代码 / 没接线 / 实现了但没调用」这类需要读代码推理的缺口，归到 T14（E4 replanner）那条线，本期不做。

## 2. 需求

- **REQ-L4c-001**:（必须）PR merged → 取该 PR 关联任务的 `acceptance`，与 PR diff 做 LLM 比对
- **REQ-L4c-002**:（必须）输出结构化结果：`covered[]` / `missing[]` / `riskLevel(low|medium|high)` / `reasoning`
- **REQ-L4c-003**:（必须）结果写 `store.gapAnalyses[pullId]`，可经 `GET /v2/gap-analyses` 读取
- **REQ-L4c-004**:（必须）PR 无关联任务、或任务无 acceptance → 跳过，不写记录、不报错
- **REQ-L4c-005**:（必须）LLM 返回 null / 解析失败 → 降级 `riskLevel='unknown'`，不抛错
- **REQ-L4c-006**:（应该）支持手动补跑 `POST /v2/gap-analyses/run`
- **不做**：企微推送、前端展示（另起任务）、读代码级缺口分析（归 T14）

## 3. 验收标准

- [ ] AC-L4c-001: PR merged（有关联任务且任务有 acceptance）→ `store.gapAnalyses[pullId]` 出现一条记录
- [ ] AC-L4c-002: 记录含 `covered` / `missing` 数组 + `riskLevel` + `reasoning`
- [ ] AC-L4c-003: PR 无 taskId 或任务无 acceptance → 不写记录（analyzeGap 返回 `{ skipped: true }`）
- [ ] AC-L4c-004: callClaude 返回 null → 记录 `riskLevel='unknown'`，函数不抛错
- [ ] AC-L4c-005: `GET /v2/gap-analyses` 返回当前租户全部记录；`?taskId=` 过滤
- [ ] AC-L4c-006: 发给 LLM 的 userPrompt 同时包含 acceptance 文本与 diff 摘要

## 4. 技术方案

### 数据结构

```
store.gapAnalyses: { [pullId]: GapAnalysis }   // migrateStore 默认 {}

GapAnalysis = {
  pullId, taskId, prNumber,
  covered:   string[],            // 已覆盖的验收点
  missing:   string[],            // 缺失/未覆盖的验收点
  riskLevel: 'low'|'medium'|'high'|'unknown',
  reasoning: string,
  source:    'llm'|'fallback',
  acceptance: string,             // 比对时的 AC 快照
  analyzedAt: ISO string
}
```

### 接线点

```
PR merged webhook（webhookRoutes.js，E1 refreshAnalysis 旁边）:
  if (action === 'closed' && pull_request.merged === true)
    → import('../services/gapAnalyzer.js')
        .then(({ analyzeGapForMergedPR }) =>
           analyzeGapForMergedPR({ repoFull, prNumber }, loadStore, updateStore))
        .catch(log)                     // fire-and-forget，不阻塞 webhook 响应

手动补跑:
  POST /v2/gap-analyses/run { pullId }  → routes/gapAnalyses.js → analyzeGap(pull, store, updateStore)

读取:
  GET /v2/gap-analyses[?taskId=]        → 读 store.gapAnalyses，按 tenant 过滤
```

### gapAnalyzer.js（自包含服务）

```
analyzeGap(pull, store, updateStore):
  taskId = pull.taskId || pull.linkedTaskIds?.[0]
  task   = store.tasks.find(t => t.id === taskId)
  if (!task?.acceptance) return { skipped: true, reason }     // REQ-004

  diff = await fetchPRDiff(owner, repo, pull.number)           // owner/repo 从 pull.repo 或 project 解析
         .slice(0, DIFF_MAX_CHARS=8000)                        // 截断控制 token
  raw  = await callClaude(TRACE_SYSTEM /*静态,可缓存*/, buildUserPrompt(task.acceptance, diff))
  parsed = parseJsonOutput(raw)
  result = parsed
    ? { covered, missing, riskLevel, reasoning, source:'llm' }
    : { covered:[], missing:[], riskLevel:'unknown', reasoning:'LLM 不可用，降级', source:'fallback' }  // REQ-005
  updateStore(draft => { draft.gapAnalyses[pull.id] = { ...result, pullId, taskId, ... } })

analyzeGapForMergedPR({ repoFull, prNumber }, loadStore, updateStore):
  store = await loadStore('default')
  pull  = store.pulls.find(p => p.prNumber === prNumber || p.number === prNumber)   // + repo 匹配
  if (!pull) return { skipped: true }
  return analyzeGap(pull, store, updateStore)
```

**System prompt 静态**（`cache_control: ephemeral` 友好）：只放角色 + 输出 JSON 约定，不放 acceptance/diff（会变内容）。acceptance + diff 全进 userPrompt。

## 5. 差距分析

| 能实现的 | 实现不了的 |
|---|---|
| acceptance 文本 ↔ diff 的覆盖度判断 | 「实现了但没接线/死代码」（需读代码，归 T14） |
| 结构化 covered/missing + 风险等级 | 跨多 PR 累积的验收点 |
| LLM 不可用时降级不阻断 | acceptance 写得含糊时的判断质量 |

## 6. 相关工作与依据谱系（重要：T13 在最浅一级）

「PR 是否真正实现了任务验收标准」属于**需求↔实现一致性验证**问题。文献里有三级谱系，可靠性与成本递增：

| 级别 | 做法 | 代表工作 | 能答 / 答不了 | CUE 对应 |
|---|---|---|---|---|
| **一级 · 静态文本判断** | 把需求+diff 文本喂 LLM，一次性出判断 | 2603.00539、FORGE 2025、TraceLLM | 字面覆盖度 / **答不了「接没接线、跑不跑得通」** | **T13（本 spec）** |
| **二级 · 静态工具型 Agent** | Agent 进仓库跨文件读、看调用图，不执行 | DCE-LLM(arXiv 2506.11076)、Semgrep+LLM、Agentable(CPG+LLM) | 「实现了但没接线/死代码」 | T14（读代码线） |
| **三级 · 执行/浏览器 Agent** | 真 checkout、跑测试、起服务点页面 | AgentForge(2604.13120)、Verify-Before-You-Fix(2604.10800)、Agentic Rubrics(2601.04171)、You-Name-It-I-Run-It(2412.10133) | 「声称做了但实际跑不通」 | E2/L5 |

**核心原理（execution grounding）**：二/三级的可靠性来自把判断**锚定到客观信号**（调用图、测试红绿），旁路掉 LLM 自身偏差。T13 是一级，没有这种锚定 —— 这是它天花板的来源，非实现 bug。

### 设计风险（必须知道）：systematic overcorrection

2603.00539 实测：LLM 在「判断代码是否满足需求」时**系统性把已满足的判成「缺失/不合规」**（假阴性高）。更关键 —— **越是要求「解释 + 列举」的详细 prompt，错得越狠**（GPT-4o 在 MBPP 上 FNR 35.9% → 87.9%）。

T13 现有 prompt 正是「输出 covered/missing/reasoning」的重解释形态，**因此 `missing[]` 很可能虚高、`riskLevel` 偏高**。当前缓解：结果仅供人工复核、不自动建任务/不推送（与 FORGE、TraceLLM 的「半自动决策支持」立场一致）。

待办优化（不改架构）：
- (b) prompt 加「判 missing 必须指出 diff 中找不到对应实现」的证据门槛，抬高误报阈值；
- (a) 拆两段：先逐条 yes/no 判定、再单独要理由，避开「边解释边判定」毒区（改动较大，后续）。

> 早期错误归因更正：本场景曾被记为「TraceLLM ④-d：PR diff → acceptance criteria」，实为 CUE 自有外推 —— TraceLLM 任务是文档↔文档配对，不含代码/diff。见 docs/research/llm4re-survey.md。

## 7. 实现笔记

已实现（2026-06-14，feat/l1-prd-clarifier 分支）：

- **新增** `server/services/gapAnalyzer.js`：`analyzeGap(pull, store, updateStore, tenantId, deps)` + `analyzeGapForMergedPR({repoFull,prNumber}, loadStore, updateStore, tenantId)`。`deps` 可注入 `{ fetchPRDiff, callClaude }` 供测试离线运行。
- **新增** v2 route `server/v2/routes/gapAnalyses.js`：`GET /v2/gap-analyses[?taskId=]`、`POST /v2/gap-analyses/run {pullId}`；在 `server/v2/app.js` ROUTE_MODULES 注册（排在 `/v2/learning` 前）。
- **接线** `server/routes/webhookRoutes.js`：PR merged 块内、E1 `refreshAnalysis` 旁加 fire-and-forget 调 `analyzeGapForMergedPR`。
- **store** `migrateStore()` + seed 默认对象补 `gapAnalyses: {}`（dict，键为 pullId，与 `semanticLinks` 同类，不进 TENANT_STAMP_ARRAYS；记录内自带 `tenantId`，route 按 tenant 过滤）。
- **测试** `scripts/test-gap-analyzer.mjs`：7 例全过（LLM 成功结构、null/非 JSON 降级 unknown、无 taskId/无 acceptance 跳过且不调 LLM、linkedTaskIds 回退、prompt 含 AC+diff 且 system 不含可变内容）。`npm run check`（207 文件）+ `npm run test:unit`（27 通过）绿。

未做（按设计边界）：企微推送、前端展示、读代码级缺口（归 T14）。
