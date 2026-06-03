# System Overview — CUE Agentic SDLC

## 架构全图

```
┌─────────────────────────────────────────────────────────────────┐
│                        CUE HUB                                  │
│                                                                 │
│  ① L1 澄清     ② L2 任务     ③ L3 PR       ④ L4 监控           │
│  想法→PRD  →  PRD→任务树  →  任务→PR   →  仓库实时监控          │
│     ↑              ↑             ↓              ↓               │
│     │              │         ┌──────────────────┐               │
│     │              │         │  目标仓库         │               │
│     │              │         │  (OmniNexus 等)  │               │
│     │              │         │  commits / PRs   │               │
│     │              │         │  文件树 / diff   │               │
│     │              │         └──────────────────┘               │
│     │              │              ↓                             │
│     │              │         ⑤ L5 Browser Agent                │
│     │              │         像人一样测试网站                     │
│     │              │              ↓                             │
│     │         E4纠偏←──── E3风险 + E2测试 + E1完成              │
│     │              │                                            │
│     └──────── E5交付→下一轮迭代起点                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 数据流向

```
用户输入
  → L1: prdClarifier.js (新建)
  → PRD 存入 store.prds

PRD
  → L2: docsManager.js (重写 PARSE_SYSTEM_PROMPT)
  → Milestone + Task v2 存入 store

Task 认领
  → L3: githubApi.js (createBranchForTask + createDraftPR)
  → PR URL 写入 task.evidenceRefs

PR merged / opened
  → Webhook → reviewRoutes.js
  → E1: semanticLinker.js → task.status = completed
  → E3: reviewer.js → if Block → reviewTaskLinker.js → 修复任务

Browser test run
  → L5: skyvern / browser-use
  → E2: testRuns 存入 store → task.e2Status

E1 + E3 积累
  → E4: replanEvaluator.js (新建)
  → 调整建议 → 人工确认 → 增量更新 store

里程碑完成
  → E5: dailyBrief.js (扩展)
  → 复盘 → nextSuggestions → 回到 L1
```

## 模块映射（代码 → Spec）

| Spec | 主要代码文件 | 状态 |
|---|---|---|
| L1 | `server/services/prdClarifier.js`（新建）| ❌ |
| L2 | `server/services/docsManager.js`（重写 schema）| ⚠️ 改造 |
| L3 | `server/services/githubApi.js`（扩展）| ⚠️ 扩展 |
| L4-c | `server/services/gapAnalyzer.js`（新建）| ❌ |
| L5 | `server/services/browserTestRunner.js`（新建）| ❌ |
| E1 | `server/services/semanticLinker.js`（扩展状态回写）| ⚠️ 扩展 |
| E2 | `server/services/testResultLinker.js`（新建）| ❌ |
| E3 | `server/services/reviewTaskLinker.js`（新建，<50行）| ❌ |
| E4 | `server/services/replanEvaluator.js`（新建）| ❌ |
| E5 | `server/services/dailyBrief.js`（扩展里程碑复盘）| ⚠️ 扩展 |

## Phase 实施顺序

```
Phase 1（止血，8-10 周）★ 最优先 ★
  E1 + E3 + L2 schema 重做
  → 目标：任务板不再归零，进度变真实

Phase 2（闭环成形，12-16 周）
  L1 + L4-c + E4
  → 目标：有澄清入口，能发现业务缺口，能纠偏

Phase 3（护城河，16-24 周）
  L5 + E2 + E5
  → 目标：browser agent 测试 + 迭代闭环

Phase 4（研究级）
  音视频测试 — 等工具链
```

## 依赖图

```
L1 ──────────────────────────────────────────→ L2
                                               ↓
                                        L3 ←──┘
                                        ↓
                                    [目标仓库]
                                        ↓
E1 ←── L4-a ←──────────────────────────┤
E3 ←── L4-b ←── L5 ←──────────────────┤
E2 ←── L4-c ←──────────────────────────┘
           ↓
E4 ←── [E1+E3 信号]
           ↓
E5 ←── [里程碑完成] ──→ L1（下一轮）
```
