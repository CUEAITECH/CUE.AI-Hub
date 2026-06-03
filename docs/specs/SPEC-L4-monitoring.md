---
id: SPEC-L4
title: "L4 — 实时监控：commit 状态 / diff 风险 / 业务缺口 / PR 还差什么"
status: draft
type: layer
index: 4
fidelity: 65%
open-source-basis:
  - TraceLLM (commit→requirement traceability)
  - APM Planner (codebase gap analysis)
  - CUE reviewer.js (diff risk, already working)
cue-seed:
  - server/services/semanticLinker.js
  - server/services/reviewer.js
  - server/services/riskEngine.js
  - server/services/githubApi.js (scanGitHubProject)
dependencies:
  - SPEC-L2
  - SPEC-E1
  - SPEC-E3
effort-weeks: 5
phase: 2
---

# SPEC-L4：实时监控

## 1. 目标

> 实时回答四个问题：① 仓库里做完了多少？② 哪些 diff 有风险？③ PRD 里哪些业务功能还没实现？④ 每个 PR 还差什么才能合并？

## 2. 子模块分解

| 子模块 | 可实现度 | Phase | CUE 种子状态 |
|---|---|---|---|
| L4-a: commit→任务完成度 | 80% | 1（→E1）| ✅ 最强 |
| L4-b: diff 风险扫描 | 83% | 1（→E3）| ✅ 已工作 |
| L4-c: 业务缺口分析 | 52%（无E2）/71%（有E2）| 2 | ⚠️ 需扩展 |
| L4-d: PR 还差什么 | 72% | 2 | ⚠️ 需接线 |

## 3. 需求

### L4-a（commit → 任务完成度）→ 见 SPEC-E1

### L4-b（diff 风险）→ 见 SPEC-E3

### L4-c 业务缺口分析

- **REQ-L4-C-001**:（必须）读取目标仓库文件树（不需要克隆，用 GitHub Contents API）
- **REQ-L4-C-002**:（必须）对比 PRD acceptance / SPEC 的 AC-xxx 与代码现状，输出三类：`implemented` / `partial` / `missing`
- **REQ-L4-C-003**:（应该）对"缺失"条目自动生成建议任务（草稿，待人工确认后才导入任务板）
- **REQ-L4-C-004**:（应该）每次 sync 后更新缺口报告，写入 `store.gapAnalysis`

### L4-d PR 还差什么

- **REQ-L4-D-001**:（必须）PR diff + 对应 task 的 acceptance → LLM 生成 checklist：哪些 AC 已覆盖，哪些未覆盖
- **REQ-L4-D-002**:（必须）checklist 展示在 PR 详情页（hub 里的 PR 视图）
- **REQ-L4-D-003**:（应该）未覆盖的 AC 数量 > 0 时，在 hub 给 reviewer 标记为"待完善"

## 4. 验收标准

- [ ] AC-L4-C-001: 对 OmniNexus 仓库跑一次 gap analysis，能输出"video sharing 功能缺失"（已知真实缺口）
- [ ] AC-L4-C-002: gap analysis 结果存入 `store.gapAnalysis`，可在总览页看到
- [ ] AC-L4-D-001: 任意 PR + 对应 task，能输出 AC 覆盖率（0-100%）
- [ ] AC-L4-D-002: hub PR 详情页展示"还差哪些 AC"

## 5. 技术方案

### L4-c 业务缺口分析流程

```
scanGitHubProject（已有）
  └─ 扩展：拉文件树 + 关键目录内容（src/ components/ api/ tests/）
        ↓
analyzeGap(prds, fileTree, keyFiles)
  └─ Prompt：
     "以下是 PRD 的验收标准列表和仓库代码结构。
      对每条 AC，判断代码中是否有对应实现。
      输出 {ac_id, status: implemented|partial|missing, evidence, suggestion}"
        ↓
store.gapAnalysis = { projectId, updatedAt, items: [...] }
```

**Token 控制策略（参考 APM + context engineering）**：
- 文件树：只传路径（不传内容），约 2000 tokens
- 关键文件内容：按 AC 关键词选最相关的 5-10 个文件，每文件截 300 行
- 总计控制在 16K tokens 以内

### CUE 接入点

```
新增: server/services/gapAnalyzer.js
  - analyzeGap(project, prds, store): 返回 GapAnalysisResult

改动: server/services/githubApi.js（scanGitHubProject）
  - 新增 fetchFileTree(owner, repo): 返回文件路径列表
  - 新增 fetchRelevantFiles(owner, repo, keywords): 按关键词拉相关文件内容

新增路由: GET /api/projects/:id/gap-analysis
          POST /api/projects/:id/run-gap-analysis
```

## 6. 差距分析

| 能实现的 | 实现不了的 | 硬上限 |
|---|---|---|
| 静态代码 gap analysis（文件/函数存在性）| 功能是否真的能用（需 E2）| 60% 无 E2 |
| PR 的 AC 覆盖率 | 跨 PR 的合并覆盖率 | 依赖 acceptance 质量 |
| 缺口建议任务生成 | 自动判定是否真的实现（非"代码有"）| 需要 E2 + 人判断 |

## 7. 实现笔记

> 待实现后更新。
