# CUE 项目中枢 v2 — 架构改造方案（讨论稿）

> 日期：2026-05-21
> 状态：方案讨论中，待用户逐条勾选 Part I 决策点
> 关联：第七阶段 PR 流迁移、第八阶段 token 修复、三端同步设计稿
> 配套复盘：`2026-05-21-rewrites-postmortem.md`

---

## 前情提要

本方案诞生于第八阶段尾声。经过 4 次大刀阔斧的底层重写（分工领取 / AI PM / 交付层 / PR 流），每次都在业务层换算法，但 store / 事件 / 调度的底盘从未换过。**这次方案的核心主张：先换地基，业务层一行不动；地基稳了，再按需替换业务模块。**

---

## 北极星

本计划服务于一个更大的愿景：`2026-05-21-product-vision.md`

> 为混合团队（人类 + AI agent）设计的操作系统。
> 人类和 AI agent 都是第一类团队成员。
> 工作在通信平台之上，不依赖任何一个。
> 团队积累的记忆是核心资产。

**v2 是地基，不是终点。** 每一个架构决策必须问：这个选择会不会在 12 个月后的愿景里挡路？

---

## Part A · 为什么前 4 次重写不收敛

| 重写 | 想解决什么 | 为什么没解决 |
|---|---|---|
| 阶段 4：API QA | 任务进度估算粗糙 | 还是在 commit 流上加了一层 LLM，没改 store |
| 阶段 5：几何平均健康度 | 单维度补偿 | 算法对了，但读的还是 `store.reviews` 实时查询 |
| 阶段 6：reviewer/QA 合并 | 双 LLM 打架 | 把两份 prompt 合一份，但数据源 (commit) 没换 |
| 阶段 7：PR 流迁移 | commit 是真源 | PR 表加上了，但 `riskEngine` / `dailyBrief` 还在读 `store.activities` |
| 阶段 8：webhook + token 修 | 频次失控 | 在 `pullPipeline` 加 dry-run + skip，但并发竞争还在 `updateStore` |

**共同病灶：每次都在业务层换算法，从来没换地基。** `updateStore` 是全量覆盖写、单 cache 指针、无事务、无事件，所以任何"事件→三端响应"都做不了，只能往 `setInterval` 和 `webhook handler` 里塞更多调用，越塞越乱。

---

## Part B · 不再造的轮子（替代清单）

| 自写模块 | 行数 | 推荐替换 | 替换理由 |
|---|---|---|---|
| 裸 `http` 路由 (`server/index.js`) | 447 | **Fastify 4** | 轻量、内置 schema 校验、性能高于 Express |
| `db.json` + `store.js` | 435 | **better-sqlite3 + Kysely** | 同步驱动 5µs/查询，单节点 Hub 完全够用 |
| `updateStore(mutator)` 并发写 | — | **`p-queue` 单写者 actor** | 100 行实现，所有 mutation 串行化 |
| `scheduler.js` setInterval 时钟 | 250+ | **`node-cron`** | cron 表达式 `'45 17 * * 1,2,4,5,7'` 一行替代手写 |
| `githubApi.js` REST 封装 | 254 | **`@octokit/rest` + `@octokit/webhooks`** | GitHub 官方 SDK，重试/限流/分页/验签全内置 |
| `githubWebhook.js` 验签 | 75 | **`@octokit/webhooks`** | 删 75 行 |
| `localGit.js` | 119 | **删除**（PR 流后已废） | — |
| `mailer.js` | 118 | **`nodemailer`** | 标准库 |
| `dailyBrief.js` 模板拼接 | 496 | 保留逻辑，**模板换 `eta`** | 当前是 join('\n')，长期不可维护 |
| `docsManager.js` (54K!) | 1204 | **拆分 + 引入 `remark` AST 解析** | 现在是字符串 split + 正则，脆弱 |
| `planner.js + scoring.js + dailyTaskSuggester.js + assignmentBrief.js` | 1317 | **合并成 `features + ranker + explainer` 三件套** | 4 份独立的打分逻辑互不共享特征 |
| `reviewer.js` diff 截断 4000 字符 | 214 | **保留 prompt，diff 走 `parse-diff` + `tree-sitter`** | AST 切片消除截断 |
| `semanticLinker.js` 向量召回 | 215 | 保留，**向量召回换成 `sqlite-vec`** | 当前 LLM 全召回巨贵 |

新增依赖（一次性 npm install）：

```
fastify @fastify/cors @fastify/helmet
better-sqlite3 kysely
@octokit/rest @octokit/webhooks
p-queue node-cron
zod xstate
eta remark remark-parse remark-stringify unified
parse-diff tree-sitter tree-sitter-javascript
pino pino-pretty
nodemailer
```

可选（P3+ 引入）：`sqlite-vec`（向量召回）、Semgrep CLI（静态分析前置）

---

## Part C · 目标架构

```
                   ┌─ GitHub webhooks ─┐  ┌─ WeCom plugin ─┐  ┌─ 前端 ─┐
                   │ (octokit/webhooks)│  │     (HTTP)     │  │ (HTTP)  │
                   └────────┬──────────┘  └────────┬───────┘  └────┬────┘
                            │                     │              │
                            ▼                     ▼              ▼
                   ┌────────────────── Fastify ─────────────────────┐
                   │    routes 仅做参数校验 + 产出 Event             │
                   └──────────────────────┬─────────────────────────┘
                                          │ event {type, payload, src}
                                          ▼
                   ┌──────────── EventBus (in-process) ──────────────┐
                   │  outbox 表落库 → 内存订阅者 fan-out               │
                   └──┬──────────┬───────────┬───────────┬──────────┘
                      │          │           │           │
                      ▼          ▼           ▼           ▼
                ┌─────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐
                │ Task SM │ │Reviewer│ │ Doc Sync │ │ Notifier │
                │ reducer │ │ worker │ │  worker  │ │ (WeCom)  │
                └────┬────┘ └────┬───┘ └────┬─────┘ └────┬─────┘
                     │           │          │            │
                     ▼           ▼          ▼            ▼
                ┌───────────────────────────────────────────────┐
                │   SQLite (better-sqlite3) + Kysely + WAL      │
                │   写入由单一 actor 串行化 (p-queue)            │
                └───────────────────────────────────────────────┘
                                  │
                                  └─ node-cron 触发器（晚会 17:45 / 18:00）
```

**四条铁律**：
1. route 不写 DB（只校验 + 投递 event）
2. 每个 event 落 outbox 表（可重放，可审计）
3. 任务状态机显式化（`pending → claimed → in_progress → in_review → merged → done` 五个枚举）
4. 三端同步是 worker 订阅 event，不再是路由处理器同步调用

---

## Part D · 文件级迁移表

### 保留不动（13 个）
`claude.js`、`prAgentParser.js`、`wecom.js`、`riskEngine.js`、`bindingEngine.js`、`complianceAggregator.js`、`auth.js`、`syncTrace.js`、`mailer.js`（依赖换）、`stageChecklist.js`、`dailyBrief.js`（仅模板换）、`githubWebhook.js`（验签换）、`semanticLinker.js`

### 重写或拆分（5 个）
- `store.js` → `db/index.ts` + `db/migrate.ts` + `db/actor.ts`
- `scheduler.js` → `cron/index.ts`
- `index.js` → `server.ts` (Fastify) + 各 route 改写
- `scoring.js + planner.js + dailyTaskSuggester.js + assignmentBrief.js` → `features + ranker + explainer`
- `docsManager.js` → `docs/parser.ts` + `docs/writer.ts` + `docs/syncOrchestrator.ts`

### 替换为 OSS（4 个）
- `localGit.js` → 删除
- `githubApi.js` → Octokit
- `githubSync.js` → Octokit + BullMQ（或 better-queue）
- `pullPipeline.js` 去重逻辑 → 队列 idempotency

### 新增（6 个）
- `events/bus.ts` — in-process EventEmitter + outbox
- `events/types.ts` — 全部事件 schema（zod）
- `state/taskMachine.ts` — XState 状态机（或手写 switch）
- `state/reducer.ts` — 处理 event → DB mutation
- `workers/index.ts` — 各 worker 注册
- `obs/ledger.ts` — LLM 调用账本（升级 syncTrace）

---

## Part E · SQLite Schema

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner TEXT,
  due DATE,
  priority TEXT,
  state TEXT NOT NULL DEFAULT 'pending',  -- 状态机枚举
  progress INTEGER DEFAULT 0,
  acceptance TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_tasks_state ON tasks(state, project_id);
CREATE INDEX idx_tasks_owner ON tasks(owner) WHERE state IN ('claimed','in_progress','in_review');

CREATE TABLE pulls (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT, body TEXT,
  state TEXT,
  author TEXT,
  head_branch TEXT, base_branch TEXT,
  merged_at DATETIME,
  raw_json TEXT,
  created_at DATETIME, updated_at DATETIME
);

CREATE TABLE pull_task_link (
  pull_id TEXT, task_id TEXT,
  PRIMARY KEY (pull_id, task_id)
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  pull_id TEXT,
  source TEXT,           -- 'pr-agent' / 'hub'
  level TEXT,
  score INTEGER,
  compliance_json TEXT,
  issues_json TEXT,
  human_decision TEXT,
  created_at DATETIME, updated_at DATETIME
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source TEXT,
  event_id TEXT UNIQUE,        -- 幂等键
  processed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_events_unprocessed ON events(processed_at) WHERE processed_at IS NULL;

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  purpose TEXT,
  model TEXT,
  prompt_hash TEXT,
  cache_hit BOOLEAN,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  ref_type TEXT, ref_id TEXT
);

CREATE TABLE sync_signatures (
  signature TEXT PRIMARY KEY,
  source TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 还需迁移：activities / assignments / standups / attendance /
-- projects / members / users / doc_tasks / risk_alerts / health_snapshots
```

---

## Part F · 事件总线协议

```typescript
// events/types.ts
export const EventSchemas = {
  'pr.opened':         z.object({ projectId, prNumber, author, title }),
  'pr.synchronized':   z.object({ projectId, prNumber, beforeSha, afterSha }),
  'pr.merged':         z.object({ projectId, prNumber, mergedAt, taskIds }),
  'pr.closed':         z.object({ projectId, prNumber }),
  'pr.review.posted':  z.object({ projectId, prNumber, source, level, complianceDelta }),
  'pr.bypass.detected':z.object({ projectId, sha, branch }),

  'task.created':      z.object({ taskId, projectId, source }),
  'task.claimed':      z.object({ taskId, owner, source }),
  'task.progressed':   z.object({ taskId, fromProgress, toProgress, signal }),
  'task.merged':       z.object({ taskId, prId }),
  'task.cancelled':    z.object({ taskId, reason }),

  'doc.scan.requested': z.object({ projectId, paths }),
  'doc.updated':        z.object({ projectId, path, sha }),

  'standup.submitted':         z.object({ owner, date, yesterday, today, blockers }),
  'evening.report.due':        z.object({ date }),
  'evening.report.generated':  z.object({ date, reportId }),

  'risk.detected':      z.object({ alertId, severity, ref }),
  'health.recomputed':  z.object({ score, components }),
};
```

**订阅表**：

| 事件 | reducer | reviewer | doc-sync | notifier | scoring |
|---|---|---|---|---|---|
| `pr.opened` | ✅ | ✅ (cheap) | — | — | — |
| `pr.synchronized` | ✅ | ✅ (full) | — | — | — |
| `pr.merged` | ✅ | — | ✅ | ✅ | ✅ |
| `pr.review.posted` | ✅ | — | ✅ AC | — | ✅ |
| `task.claimed` | ✅ | — | — | ✅ | — |
| `task.created` | ✅ | — | ✅ | — | — |
| `evening.report.due` | — | — | — | — | ✅ |
| `evening.report.generated` | — | — | — | ✅ | — |

**幂等键**：GitHub webhook 用 `X-GitHub-Delivery`；scheduler 用 `${eventType}:${date}`；UI 用 `${userId}:${ts}`。

**循环防抖**：Hub 写入 GitHub 的 PR 评论/commit message 带 `<!-- cue-hub:event=${eventId} -->`；webhook 收到时若签名在 `sync_signatures` 表则丢弃。

---

## Part G · 算法替换分层详表

### Layer 1：任务推荐（替代 planner + scoring + dailyTaskSuggester + assignmentBrief）

三阶段管道：
```
features.ts                   ranker.ts                 explainer.ts
─────────────                 ──────────                ─────────────
• ownerLoadVector(7d/30d)     coarseScore(features)     LLM 解释 Top-3
• ownerSkillVector(commit)      = w_load × load_fit       SHAP-style
• taskKeywordVector             + w_skill × skill_fit     贡献占比
• taskUrgency (due-now)         + w_urgency × urgency
• taskDepReady                  + w_dep_ready × dep_ready

  Top 50 候选        ──▶     Top 10              ──▶    Top 3 + 理由
```

- **owner × task 拟合**：bge-m3 embedding，存 `sqlite-vec`
- **论文依据**：DeepTriage (Mani 2019)、FixerCache (Hu 2014)
- **LLM 角色**：仅在 Top 3 解释阶段调一次（当前 LLM 调用减少 80%）

### Layer 2：Code Review

```
upsertPull (webhook)
   │
   ├──> parse-diff 分文件 chunk
   ├──> Semgrep + ESLint 廉价过滤 → minor/major issue
   ├──> tree-sitter 抽 changed AST → function-level chunk
   ▼
Map: 每个 chunk 调 Haiku（task AC prompt cache）
   ▼
Reduce: 聚合 issues + 跨 chunk 软对齐 compliance
   ▼
Self-consistency 仅对 critical：n=3 投票
   ▼
emit 'pr.review.posted'
```

- **论文**：CodeReviewer (Li 2022)、PR-Agent ChunkedCompliance、Self-Consistency (Wang 2022)
- **成本**：总 token +30%，精度 ×2-3，Haiku 替代 Sonnet 后总成本反而下降

### Layer 3：风险传播 + SPACE 健康度扩展

- 任务依赖图上的 Personalized PageRank（50 行实现，Haveliwala 2002）
- 当前 DORA 4 维 → 补 SPACE 全 5 维（Satisfaction = 站会 blockers 情感分析；Performance = PR cycle time；Communication = review comment 数 / merged PR；Efficiency = 完成率）

---

## Part H · 路线图

| 周 | 主题 | 交付物 |
|---|---|---|
| W1 | **地基** | SQLite + Kysely + p-queue actor；迁移脚本；db.json 双写 7 天 |
| W2 | **事件层** | EventBus + outbox + events 表；webhook → emit event；5 个核心 reducer |
| W3 | **Fastify + Octokit** | route 全切；GitHub API 全切；删 localGit |
| W4 | **PR Prompt 自动生成器** | task 创建 → Hub 写 PR 评论；eta 模板；带签名 |
| W5 | **Reviewer Map-Reduce** | tree-sitter + parse-diff；Semgrep；与旧版 A/B 1 周 |
| W6 | **推荐三阶段** | features + ranker + explainer；删旧打分；sqlite-vec |
| W7 | **三端同步 broker** | doc-sync worker；AC 双向；防循环签名 |
| W8 | **SPACE + 风险传播** | PageRank；情感分析；前端健康度弹窗扩展 |
| W9 | **可观测性 + 文档** | ledger 上线；后台显示 LLM 成本；迁移文档 |
| W10 | **前端 v2（可选）** | 评估单文件 app.js 是否切组件化 |

**检查点**：W1-W2 完成后必须有一周双写期，行级对账后再切单源。

---

## Part I · 需要拍板的 23 个决策

请逐条 ✅ / ❌ / 改：

### 框架与运行时
1. **Fastify 4** 替换裸 http？
2. **TypeScript 全栈**？
3. **better-sqlite3 + Kysely** 作为存储层？
4. **保留 `db.json` 作为只读导出**，每日 dump 一份到 git？

### 事件 & 队列
5. **outbox + in-process EventEmitter** 还是 **BullMQ + Redis**？
6. **XState** 任务状态机 还是 手写 5 状态 switch？
7. 事件 schema 用 **zod** 校验？

### GitHub 集成
8. **Octokit** 替换 `githubApi.js`？
9. **Hub 写 PR 身份**：(a) 新建 `cue-hub-bot` GitHub App；(b) 复用 `github-actions[bot]`；(c) PAT
10. 删除 `localGit.js`？

### LLM & Review
11. **tree-sitter + parse-diff** 做 AST 切片？
12. **Semgrep CLI** 作为 LLM 前置静态分析？
13. **Self-consistency n=3** 仅对 critical issue？
14. **LLM 路由器**：Haiku 跑 review，Sonnet 跑 planner？
15. **sqlite-vec** 还是 **LanceDB** 做向量召回？

### 推荐算法
16. **删除** planner + scoring + dailyTaskSuggester + assignmentBrief 中重复的打分逻辑，合并成 features + ranker + explainer？
17. **UCB1 探索机制**（4 人团队可能没必要）？
18. **PageRank 风险传播**？

### 调度 & 可观测
19. **node-cron** 替换 setInterval？
20. **pino 结构化日志** 替换 console？
21. **LLM ledger 表** 替换 `syncTrace.js`？

### 范围与节奏
22. **10 周路线图是否过激**？（可压缩到 6 周如果跳过 W8 + W10）
23. **前端 `src/app.js`** 这次完全不动？

---

## Part J · 默认推荐答案（如果"按我说的来"）

```
1: ✅ Fastify     2: ❌ JS 继续   3: ✅ Kysely     4: ✅ 每日 dump
5: ✅ in-process EventEmitter（4 人团队不上 Redis）
6: ❌ 手写 switch   7: ✅ zod
8: ✅ Octokit   9: (a) 新建 cue-hub-bot   10: ✅ 删
11: ✅    12: ⏸ W5 再定    13: ✅ critical only    14: ✅    15: ✅ sqlite-vec
16: ✅ 合并    17: ❌ 不需要    18: ⏸ W8 再定
19: ✅    20: ✅    21: ✅
22: 接受 10 周    23: ✅ 前端不动
```

---

---

## Part K · v2 业务闭环（事件驱动 workflow）

### 主闭环：任务全生命周期

```
┌─────────────────────────────────────────────────────────────────────────┐
│  AI PM 创建任务                                                          │
│  ─────────────                                                           │
│  cron 17:45 OR docs/*.md push webhook                                    │
│    → emit task.create.requested                                          │
│    → planner worker（LLM）解析候选 → emit task.created                   │
│    → reducer 写 tasks 表（state=pending）                                │
│    → doc-sync worker 注入「阶段进度.md」（⬜ 待领取）                       │
│    → notifier 推企微「今日新候选任务 N 个」                                │
└─────────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  开发者领取                                                              │
│  ────────                                                                │
│  前端点 ✓ / 企微 weComClaimTask / 18:00 晚会会后领取                       │
│    → emit task.claimed                                                   │
│    → reducer：tasks.state pending → claimed，写 owner                    │
│    → bot worker：在目标仓库 issue 自动开（含 task spec + AC + doc 链接）  │
│    → notifier：企微 @owner 「你领取了 X 任务」                            │
│    → doc-sync：「阶段进度.md」⬜ → 🔶                                      │
└─────────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  开发者开发                                                              │
│  ──────────                                                              │
│  git push                                                                │
│    → github webhook → emit commit.pushed                                 │
│    → reviewer worker（cheap path：仅跑 Semgrep + AC 软对齐）              │
│    → 在 PR comment 实时勾 [x]/[ ]/[~]                                     │
│    → reducer：tasks.state claimed → in_progress                          │
│                                                                          │
│  git push to PR branch                                                   │
│    → emit pr.synchronized                                                │
│    → reviewer worker（full path：Map-Reduce LLM AC + issue）             │
│    → emit pr.review.posted (source=hub)                                  │
│    → reducer：写 reviews 表，更新 task.compliance                         │
└─────────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PR-Agent 介入                                                           │
│  ─────────────                                                           │
│  GitHub Actions 跑 pr-agent.yml                                          │
│    → PR-Agent 写 review comment                                          │
│    → webhook → emit pr.review.posted (source=pr-agent)                   │
│    → reducer：合并 compliance（PR-Agent 权威，Hub 作为预览过渡）           │
│    → doc-sync：「阶段进度.md」更新进度百分比                              │
└─────────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  合并                                                                    │
│  ────                                                                    │
│  GitHub merge → webhook → emit pr.merged                                 │
│    → reducer：task.state in_review → merged → done（状态机串接）          │
│    → doc-sync：「阶段进度.md」🔶 → ✅                                     │
│    → notifier：企微「X 已合并任务 Y」                                     │
│    → scoring worker：进度归 100，触发 health.recomputed                   │
└─────────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  晚会作战包                                                              │
│  ───────────                                                             │
│  cron 17:45 → emit evening.report.due                                    │
│    → scoring worker：聚合当日 events 表（claim/commit/PR/review/merge）   │
│    → planner worker：生成"今日完成/明日推荐"两段叙事                       │
│    → emit evening.report.generated                                        │
│    → notifier 推企微（带签名 <!-- cue-hub:event=evening_${date} -->）     │
│    → cron 18:00 → emit meeting.start                                     │
│    → 18:00-19:00 期间任何 task.claimed 事件标记为"会后领取"               │
└─────────────────────────────────────────────────────────────────────────┘
```

### 关键事件级保证

| 事件 | 幂等键 | 重放语义 | 副作用 |
|---|---|---|---|
| `task.created` | `${projectId}:${taskHash}` | 同 hash 不重复创建 | 写 task 表 + doc-sync |
| `task.claimed` | `${taskId}:${owner}` | 同人同任务不重复 | 改 owner + 企微 |
| `commit.pushed` | GitHub delivery id | 重放无副作用（只 trigger review）| AC 勾选 |
| `pr.review.posted` | `${prId}:${source}:${createdAt}` | 同源同时刻只一次 | 更新 reviews 表 |
| `pr.merged` | `${prId}:merged` | 只触发一次 | 三端关闭 |
| `evening.report.due` | `evening:${date}` | 同日只一次 | 推企微 |

### 三端同步矩阵（每事件 → 三端响应）

```
事件               Hub (tasks表)         GitHub (PR/doc)      WeCom
─────────────────  ────────────────────  ──────────────────   ─────────────
task.created       INSERT state=pending  Doc：写入 ⬜          每日汇总 ✦
task.claimed       UPDATE state=claimed  PR 模板预填          @ 领取人 ✦
commit.pushed      —                     PR comment AC 勾选   —
pr.synchronized    —                     Hub bot 写 review    —
pr.review.posted   UPSERT reviews        —                    P1 Block 时 @ ✦
pr.merged          state=done            Doc：⬜→✅            汇总 ✦
evening.report     —                     —                    作战包 ✦
```

✦ = 带签名防循环（v2 Part F）。

---

## Part L · 前端体验差别

### 重要前提：决策 23 选 ✅ — `src/app.js` 4824 行**不重写**

所有 v2 前端能力以"增量补丁"方式实现，新增 ≤ 800 行：
- 后端新增 `GET /api/events?since&type&limit` 历史接口
- 后端新增 `GET /api/events/stream` SSE 端点（替代轮询）
- 前端新增 5 个 render 函数 + 5 段 CSS，不动现有路由

### 用户旅程对照：罗子宽接到新任务到合并

| 阶段 | v1（现状）| v2 |
|---|---|---|
| **看到任务** | 群里 @ + 在 Hub 找 task ID | 企微直接收到 @"你被推荐 3 个任务，回复编号领取" |
| **了解任务** | 进 Hub 看 task 卡片 + 翻 doc 找 spec | PR 描述里就有完整 spec（task + AC + doc 链接 + 同领域历史 PR）|
| **认领** | 进 Hub → "会后领取" panel 点 ✓，或群里说"我领" | 企微回复"1" 或 PR 描述里 `/claim` 一行；前端实时收到 SSE 刷新 |
| **开发中看 AC 进度** | 看不到，必须等晚会对账 | PR 评论区**实时勾选**（每 commit 更新）|
| **AI Review 看不懂** | PR-Agent 是英文，得自己翻 | Hub bot 在 PR 留中文版评论，附"等级 / 不满足项 / 修复建议" |
| **改完一轮想知道是否过关** | 等下次 cron 同步（最长 10 分钟）| PR 推 commit → webhook → 秒级在 PR 评论刷新 |
| **合并后** | 进度可能没动，等晚会 | task 立刻关闭，doc 立刻 ✅，企微推合并通知 |
| **想看历史问题** | 翻 git log + grep | 进 Hub 观察台，按 task 过滤 events，timeline 一目了然 |

### 五个前端新增视图（最小补丁清单）

#### V1：任务卡片"推荐理由"区块（新增 ~80 行）

现状：任务卡片只显示 title/owner/due/progress
新增：

```
┌────────────────────────────────────────┐
│ 教师端 TRTC 入口  [P1] [进行中]          │
│ owner: 罗子宽  due: 05-25  progress: 67% │
├────────────────────────────────────────┤
│ 🤖 为什么推给罗子宽（v2 新增）           │
│   • 近 7 日无前端任务负载  +0.31         │
│   • 任务关键词「TRTC/UI」与历史匹配 +0.42 │
│   • 临近截止                    +0.18    │
│   置信度：87%                            │
└────────────────────────────────────────┘
```

数据源：`GET /api/tasks/:id/explanation`（Layer 1 explainer 输出）

#### V2：PR 详情面板实时 AC checklist（新增 ~120 行）

现状：PR 详情显示 hubReview 的最新 compliance（静态）
新增：通过 SSE 订阅 `pr.${id}.review.posted` 事件，AC 三桶实时变化

```
┌────────────────────────────────────────┐
│ PR #128 教师端 TRTC 入口                 │
├────────────────────────────────────────┤
│ 验收对照（v2 实时）                      │
│ ✅ 老师点击进入课堂可成功推流  [x]       │
│ 🔶 关闭按钮可正确退出房间      [ ]       │
│    └─ 来自 commit a3b4c5 (5 分钟前)     │
│ ⚠️  网络断开后自动重连         [~]       │
│    └─ 需人工 check（PR-Agent 标记）      │
│                                          │
│ 来源：PR-Agent (权威) + Hub (实时预览)   │
└────────────────────────────────────────┘
```

#### V3：健康度弹窗 SPACE 维度扩展（修改 ~60 行）

现状：DORA 4 维 + 站会覆盖率 = 5 维
新增：在原 5 维基础上加 SPACE 缺失的 4 维（同卡片，分组显示）+ 7 日趋势折线

```
DORA 维度                       SPACE 维度（v2 新增）
─────────────────────          ─────────────────────
Deployment Freq    78           Satisfaction       82
Change Fail Rate   91           Performance        76
MTTR               65           Communication      88
（已有）                         Efficiency         71

总分（几何平均）：79  ↑ 4 (vs 上周)
[7 日趋势折线]
```

#### V4：晚会作战包从"列表"改"timeline"（新增 ~200 行）

现状：作战包是 ul 列表（今日完成 / 阻塞 / 明日计划）
新增：24h timeline 卡片，横轴时间，纵轴成员；点击节点展开 event 详情

```
                 8h   12h   14h   18h          (今天)
胡佳涛           ●─●          ●●●─●●
                claim commit         pr.merged
罗子宽                    ●─●●●
                          commit + 1 PR
林世棋               ●            ●  ●
                  standup        pr.review

[hover 任意节点 → 显示 event payload]
```

数据源：`GET /api/events?since=24h&group_by=owner`

#### V5：管理观察台（全新 section，新增 ~250 行）

只 PM 和管理员看得到。给到三块卡片：

```
┌─ LLM 调用账本 ──────────────────────────┐
│ 今日：142 次调用                          │
│ ├─ reviewer：87 次（Haiku 80% / Sonnet 20%）│
│ ├─ planner： 22 次（Sonnet）              │
│ ├─ doc-sync：33 次（Haiku）               │
│ cache 命中率：64%                         │
│ 成本：¥3.42（vs 昨日 ¥8.91 ↓ 62%）        │
└─────────────────────────────────────────┘

┌─ 事件流 (events 表) ────────────────────┐
│ 实时滚动：pr.merged → task.done → ...   │
│ [按 type 过滤] [按 source 过滤] [回放]    │
└─────────────────────────────────────────┘

┌─ 三端同步健康度 ────────────────────────┐
│ task ↔ doc 一致性：100%                  │
│ task ↔ PR 一致性：98% (2 个孤儿 PR ⚠)    │
│ 防循环签名命中：5 次（健康）              │
└─────────────────────────────────────────┘
```

数据源：`GET /api/observability/{llm,events,sync-health}`

### 前端不动的部分（保留 4000+ 行）

- 全部认领 / 项目管理 / 账号管理 UI
- 总览页 / 个人中心 / 路径图渲染
- 移动端响应式（保留 mobile-dashboard-ui 分支成果）
- 企微插件交互逻辑（独立模块）

### 实施顺序

| 周 | 前端补丁 | 后端依赖 |
|---|---|---|
| W4 | V2 (PR 实时 AC) | PR Prompt 自动生成器 + SSE 端点 |
| W6 | V1 (推荐理由) | Layer 1 explainer 上线 |
| W8 | V3 + V4 (SPACE + timeline) | events 表查询 API |
| W9 | V5 (观察台) | `llm_calls` 表 + `/api/observability` |

---

---

## Part M · 持续学习与智能体闭环

### M.0 为什么这部分必须存在

v2 Part A-L 解决了"动作能被记录"，但没解决"动作好坏被衡量、被反馈、被学习"。

具体例子：AI 推荐罗子宽做某任务 → `task.claimed` 落库 ✅ 但**这个推荐准不准？后续他做完了吗？PR 一次过没改返工吗？AC 一开始勾错几条？** 这些 v2 都不知道。

没有这部分，CUE Hub 始终是"AI 增强的工具"，不是"项目持续智能体"。

---

### M.1 Outcome Ledger（AI 动作的事后评分）

#### Schema

```sql
CREATE TABLE ai_outcomes (
  id INTEGER PRIMARY KEY,
  action_type TEXT NOT NULL,    -- 'recommend' / 'review' / 'plan' / 'ac-check' / 'risk-alert'
  action_ref_id TEXT NOT NULL,  -- 关联 llm_calls.id 或 events.id
  outcome_signal TEXT NOT NULL,
  polarity INTEGER NOT NULL,    -- +1 / -1 / 0
  evidence_json TEXT,           -- 为什么是这个 polarity，附带证据链接
  observed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  observation_lag_hours INTEGER,
  observer TEXT                 -- 'auto-rule' / 'human-label' / 'rag-cluster'
);
CREATE INDEX idx_outcomes_action ON ai_outcomes(action_type, observed_at);
CREATE INDEX idx_outcomes_ref ON ai_outcomes(action_ref_id);
```

#### 各 action_type 的 outcome 信号定义

| action_type | 正向信号 (+1) | 负向信号 (-1) | 观察窗 | 自动判定来源 |
|---|---|---|---|---|
| `recommend` | owner 点 ✓ + 准时完成 + PR 一次过 | owner 拒绝/任务超期/PR 多次返工 | 7 天 | `task.claimed` + `task.merged` + `pr.synchronized` 计数 |
| `review` | 人工 confirm Pass + PR 合并 + 7 天无 revert/fix | 人工 override + 后续 fix commit revert | 7 天 | `review.human_decision` + `git log` 反查 |
| `ac-check` | merged PR 7 天后无"AC 漏了 X"补丁 | 后续 commit message 含 "fix AC" / "补齐 AC" 关键词 | 7 天 | commit message 模式匹配 + RAG |
| `plan` | 任务被领取且完成 | 任务一直没人接、或被改写、或被删 | 14 天 | `task.cancelled` / `task.claimed` |
| `risk-alert` | 被告警的任务真的延期/出问题 | 没被告警的任务出事 / 被告警的没事 | 任务结束 | `task.merged.mergedAt vs task.due` |

#### Outcome 写入触发点

```typescript
eventBus.on('task.claimed', (e) => {
  const lastRecommend = findRecommendationFor(e.taskId, e.owner);
  if (lastRecommend) emitOutcome('recommend', lastRecommend.id, 'accepted', +1);
});

eventBus.on('pr.merged', async (e) => {
  // 即时 outcome：人工 review 是否 override
  // 7 天后再跑一次"是否被 revert"检查（延迟 outcome）
});
```

延迟 outcome 用 `node-cron` 每日跑一次 backfill job。

---

### M.2 Project Memory / RAG 层

#### Schema

```sql
CREATE TABLE project_memory (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence_refs TEXT,
  embedding BLOB,
  confidence REAL DEFAULT 0.5,
  source TEXT NOT NULL,
  validated_at DATETIME,
  validated_by TEXT,
  superseded_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE VIRTUAL TABLE memory_vec USING vec0(
  memory_id INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);
```

#### Memory 分类

| kind | 含义 | 示例 |
|---|---|---|
| `convention` | 团队约定 | "PR 描述必须填'关联任务'字段" |
| `decision` | 架构决策 (ADR) | "选 SQLite 不用 Postgres，因为单节点" |
| `gotcha` | 已知陷阱 | "structuredClone 在 webhook 风暴下丢更新" |
| `pattern` | 公认好模式 | "新增 LLM 调用必须带 purpose tag" |
| `taboo` | 明令禁止 | "禁止在企微 markdown 用表格语法" |
| `success-case` | 历史成功案例 | "PR #128 是 PR 模板填充的典范" |
| `failure-case` | 历史失败案例 | "交付层迁移幽灵节点：见 postmortem M1" |

#### 冷启动数据源（一次性导入）

| 来源 | 预期产出 |
|---|---|
| `docs/开发进度.md` 第 1-8 阶段 | ~40 条 decision/convention |
| `docs/PR-WORKFLOW.md` | ~10 条 convention |
| `2026-05-21-rewrites-postmortem.md` | 9 条 gotcha + 4 条 taboo |
| `2026-05-21-three-way-sync-design.md` | ~8 条 decision |
| `CLAUDE.md` | ~15 条 convention/pattern |
| 历史 PR 描述 + review comment 近 30 条 | ~30 条 case |

预计冷启动 ~110 条种子 memory。

#### 检索流程

```
Reviewer worker 启动
  → 取 PR diff + 关联 task
  → 构造检索 query：task.title + AC + 改动文件路径
  → RAG 检索 top-5 memory（kind ∈ {gotcha, taboo, pattern, failure-case}）
  → 注入 system prompt：「以下是本项目历史教训和约定，请遵守：...」
  → 执行 LLM Map-Reduce review
  → LLM 输出与某 memory 冲突 → 触发 active learning 队列
```

#### Memory 维护

- 写入：postmortem / spec 合并到 main 时自动抽取 → 提 PR 给 PM 确认
- 验证：每 30 天对低 confidence memory 跑一次 RAG 自检
- 取代：新 memory 标 `supersedes` 旧 id，软更新

---

### M.3 周期学习 Batch

每周日 23:00 跑 `weekly-learning.ts`：

```typescript
// cron: '0 23 * * 0'
async function weeklyLearning() {
  // 1. 聚合近 7 天 outcomes
  const outcomes = await db.selectFrom('ai_outcomes')
    .where('observed_at', '>=', sevenDaysAgo).execute();

  // 2. 按 action_type 算 precision/recall/acceptanceRate
  const metrics = computeMetrics(outcomes);

  // 3. 特征贡献分析（recommend / risk-alert）
  // logistic 回归 feature_vector → polarity
  const featureAdjustments = await fitRanker(outcomes.filter(o => o.action_type === 'recommend'));

  // 4. Prompt 调整建议（review / plan）
  // 找 polarity=-1 case 做 RAG 聚类
  const promptHints = await clusterNegatives(outcomes.filter(o => o.polarity === -1));

  // 5. 输出报告
  await writeFile(`docs/learning-reports/${date}.md`, renderReport({ metrics, featureAdjustments, promptHints }));

  // 6. 自动 apply 小改动（|Δ| < 10%）
  const autoApply = featureAdjustments.filter(a => Math.abs(a.delta) < 0.10);
  for (const adj of autoApply) {
    await db.updateTable('ranker_weights').set({ value: adj.newWeight })
      .where('feature', '=', adj.feature).execute();
    emitEvent({ type: 'learning.applied', payload: adj });
  }

  // 7. 大改动 → 通知 PM 审批
  const needsApproval = featureAdjustments.filter(a => Math.abs(a.delta) >= 0.10);
  if (needsApproval.length) await notifyWeCom(buildApprovalMessage(needsApproval));

  // 8. 新 pattern → project_memory
  for (const hint of promptHints) {
    await db.insertInto('project_memory').values({
      kind: 'failure-case', body: hint.summary,
      source: 'weekly-learning', confidence: hint.confidence
    }).execute();
  }
}
```

#### 自动 apply vs 审批阈值

| 改动类型 | 自动 | 需审批 |
|---|---|---|
| Ranker 特征权重 | `|Δ| < 0.10` | `≥ 0.10` |
| Reviewer prompt examples | 新增正向 | 新增禁忌 |
| Memory 新增 | confidence > 0.7 | < 0.7 进 active learning |
| Autonomy 升级 | — | 全部需审批 |

---

### M.4 Active Learning Queue

#### 触发条件

任何 LLM 调用 `confidence < 0.6` → 写入 `active_learning_queue`：

```sql
CREATE TABLE active_learning_queue (
  id INTEGER PRIMARY KEY,
  action_type TEXT,
  action_ref_id TEXT,
  question TEXT,
  ai_answer TEXT,
  ai_confidence REAL,
  human_label TEXT,
  labeled_by TEXT,
  labeled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### UI（管理观察台 V5 内 panel）

```
┌─ Active Learning（待标 8 项）────────────────┐
│ #1 [reviewer] PR #128                         │
│ 问：这条 issue 是真的 bug 吗？                  │
│ AI：是 critical（置信度 52%）                    │
│ 证据：src/x.ts:42 ...                          │
│ [✅ 对] [❌ 不是] [🤷 不确定]                       │
└─────────────────────────────────────────────┘
```

#### 预算

- 每天最多 10 个进队列
- 超出按 ai_confidence 升序排，最不确定的优先
- PM 每天 5 分钟标完
- 月累积 ~300 条人工标签 → 喂 M.3

---

### M.5 Graduated Autonomy（自主度分级）

#### Schema

```sql
CREATE TABLE autonomy_levels (
  action_type TEXT PRIMARY KEY,
  current_level INTEGER NOT NULL DEFAULT 0,
  upgrade_threshold INTEGER,
  positive_outcomes INTEGER DEFAULT 0,
  negative_outcomes INTEGER DEFAULT 0,
  last_upgraded_at DATETIME,
  last_downgraded_at DATETIME,
  downgrade_reason TEXT
);
```

#### 升级路径

| action_type | Level 0 起步 | Level 1（100 次正向）| Level 2（500 次正向）|
|---|---|---|---|
| `recommend` | suggest only | suggest + 默认勾选 | 直接 assign，owner 7 天可撤回 |
| `review` | 留 comment | 自动合并 low-risk 小 PR | 自动合并 + 异常自动 revert |
| `ac-check` | 软对齐预览 | 权威 source | — |
| `doc-writeback` | 提 PR 等人 review | 直接 push | — |
| `risk-alert` | 通知 PM | 自动 reassign | 自动调 due |

#### Circuit Breaker

```typescript
async function circuitBreakerCheck() {
  for (const level of autonomyLevels) {
    const recent = await getRecentOutcomes(level.action_type, '7 days');
    const negRate = recent.filter(o => o.polarity === -1).length / recent.length;

    if (level.current_level > 0 && negRate > 0.20) {
      await downgrade(level.action_type, `负向率 ${(negRate*100).toFixed(0)}% 超阈值`);
      emitEvent({ type: 'autonomy.downgraded', payload: { ... } });
      notifyWeCom(`⚠️ ${level.action_type} 自主度自动降级`);
    }
  }
}
```

#### 升级审批

升级必须 PM 在 Hub 点确认；**降级是自动的**。扩权慎、收权快。

---

### M.6 实施排期

并入 v2 路线图：

| 周 | M.x 工作 | 备注 |
|---|---|---|
| W5 | M.2 RAG 提前 | 与 Reviewer Map-Reduce 同周做，立即提升 review 质量 |
| W7 | M.1 outcome ledger | 与三端 broker 同周 |
| W8 | M.4 active learning queue | 与观察台 V5 同周 |
| W11 | M.3 周期学习 batch | 累积 4 周数据后开始有意义 |
| W12 | M.5 graduated autonomy | 最后上 |

**总周期：12 周**（v2 原 10 周 + Part M 净增 2 周）。

---

### M.7 论文与 OSS 参考（必须有出处，不许"随手做"）

| 模块 | 论文 / 项目 | 用法 |
|---|---|---|
| Outcome → reward signal | **RLHF** (Ouyang 2022)、**Constitutional AI** (Bai 2022) | human feedback as signal |
| RAG | **Lewis 2020** *Retrieval-Augmented Generation*、**LlamaIndex** | 检索增强生成框架 |
| Embedding | **bge-m3** (BAAI 2024) | 多语言/长文 SOTA |
| 向量索引 | **sqlite-vec** (asg017/sqlite-vec) | 嵌入 SQLite |
| 主动学习 | **Settles 2009** *Active Learning Literature Survey* | uncertainty sampling |
| 自主度升级 | **Anthropic Computer Use 2024** sandbox→limited→broad 分级 | 渐进式信任 |
| Circuit breaker | **Nygard 2007** *Release It!* | 稳定性模式 |
| 权重在线更新 | **scikit-learn SGDClassifier** / **River** | logistic 回归更新 ranker |

---

## Part N · 工程宪章（防止再出"随手做的算法"）

这一部分是承诺，不是建议。**没有这一部分，前面所有方案都会重蹈覆辙。**

### N.1 算法引入条款

**任何新算法 / 新打分逻辑 / 新启发式规则，PR 描述必须包含至少其一**：
1. 论文引用（含 DOI / arXiv ID）
2. 公认 OSS 实现的链接（GitHub stars ≥ 500 或属于知名组织）
3. 显式说明"这是经验调参参数（tuning parameter），不是算法" + 团队达成共识的 issue 链接

CI 自动检查此条款（grep PR 描述）。

### N.2 抽象引入条款

**新增任何抽象（接口 / class / DSL）前**：
1. 至少有 3 个真实 caller（不许"为未来准备"）
2. 必须能在 5 分钟内画出来给团队解释（拍照存 `project_memory.decision`）

### N.3 测试不变量条款（来自 postmortem R2）

**每个新数据关系，必须先写不变量测试，再写业务测试**：

```typescript
test('invariant: no orphan task.deliverableId', () => {
  const tasks = db.selectFrom('tasks').where('deliverable_id', 'is not', null).execute();
  for (const t of tasks) {
    expect(db.selectFrom('deliverables').where('id', '=', t.deliverable_id).execute()).toHaveLength(1);
  }
});
```

CI 强制：不变量测试覆盖率 100%（每个 FK / 状态机 / 唯一性都有一个不变量测试）。

### N.4 调试开关前置条款（来自 R4）

**每个 LLM 调用点 / 外部 API 调用点，出生即带**：
1. `purpose` 标签（写 `llm_calls.purpose`）
2. 支持 `DRY_RUN_<MODULE>=true` 环境变量短路
3. 通过 actor 队列，可被外部限流

不许"出事了再插桩"。

### N.5 Reset 独立条款（来自 R1）

**任何 "reset" / "clear" / "重置" 操作必须**：
1. 独立 event 类型（如 `project.reset.requested`）
2. 独立 reducer 处理，不耦合在 import 路径里
3. emit 级联清理 event（FK 关联表自动清）

### N.6 硬编码 Fallback 节制条款（来自 R3）

**写硬编码 fallback 前必须问**：
1. 项目无关版本是否可做？
2. fallback 上线后是否有 90 天内替换计划？无则不写

### N.7 重写禁止条款（最重要）

**"大刀阔斧的重写"是上瘾物质**。从 v2 落地起，**任何超过 200 LOC 的 refactor PR 必须**：
1. 在 issue 阶段获得 PM + 至少一名工程的明确 ✓
2. 包含 "为什么不可以增量做" 的论证段落
3. 包含 outcome 验证计划（怎么证明这次重写比上一次成功？）

W1-W12 完成后，**12 个月内严禁全模块重写**。出问题就在事件 + reducer 层面查根因，不在算法层抡大锤。

---

## Part O · 生产化与运营

### O.1 CI/CD 必需项

| 项 | 内容 | 阻塞合并 |
|---|---|---|
| `npm run check` | 语法 + regression tests | ✅ |
| `npm run test:invariants` | 全部 FK / 状态机 / 唯一性不变量 | ✅ |
| `npm run test:event-replay` | 固定 events.jsonl 回放，期望 store 哈希匹配 | ✅ |
| `npm run smoke` | 启动服务跑 30 个 API 冒烟 | ✅ |
| Schema migration check | db 当前 schema vs `db/migrations/` 末态 | ✅ |
| LLM dry-run | 关键路径必须支持 DRY_RUN，CI 默认开 | ✅ |
| commit-policy | 已有的 CUE_AI_GITHUB_RULES 检查 | ✅ |

### O.2 备份与恢复

- **SQLite WAL 模式 + Litestream**（同步到 S3 / R2，每 10 秒一次）
- 每日 23:55 dump `db.json` 镜像到 git（决策 4 ✅）— **作为人工可读快照**，不是恢复源
- 灾难恢复：Litestream 拉最新 WAL → 启动服务 → 自动回放未处理 events

### O.3 监控与告警

| 指标 | 阈值 | 通知 |
|---|---|---|
| events 表未处理数 | > 50 持续 5 min | 企微 P1 |
| llm_calls 失败率 | > 10% / 5min | 企微 P1 |
| llm_calls 成本 | 当日 > ¥50 | 企微 P2 |
| webhook 处理延迟 | p99 > 30s | 企微 P2 |
| 三端同步孤儿数 | > 5 | 企微 P3 |
| autonomy circuit breaker 触发 | 任何 | 企微 P1 + Hub 弹窗 |

监控数据全部从 `events` / `llm_calls` 表实时查询，不引入 Prometheus / Grafana。

### O.4 Runbook（常见事故应对）

写入 `docs/runbook.md`：

| 现象 | 第一步 | 第二步 |
|---|---|---|
| 企微大量重复推送 | 查 `sync_signatures` 是否被绕过 | 临时禁用 notifier worker |
| LLM 调用突增 | 按 purpose 分组查 llm_calls | 定位 worker，开 DRY_RUN_<X> |
| 三端不一致 | 看未处理 events 堆积 | 回放未处理 events |
| 任务进度异常 | 看 `events WHERE type='task.progressed'` 的 source | 找错误 source 的 worker |
| 数据库锁 | 检查 actor 队列长度 | 限流入口 |

### O.5 文档要求

- **架构文档**（本文）保持更新，每次大改 PR 必须修
- **runbook.md** 每事故事后必加一行
- **decision log（ADR）** 凡涉及"为什么这么做"写入 `project_memory.decision`

---

---

## Part Q · 愿景对计划的四个根本调整

在 Part A-O 的基础上，产品愿景（`2026-05-21-product-vision.md`）要求对 v2 做四处根本性的架构调整。这不是加功能，是改核心假设。

---

### Q.1 Actor 系统：取代所有 `owner: string`

这是最重要的改动，影响整个数据模型。

**原来的假设**：`owner` 是一个字符串，指向一个人类成员。

**新的假设**：执行任务的是一个 `actor`，可以是人类，也可以是 AI agent。系统不关心 actor 的性质，只关心它的能力和可信度。

#### 新增 `actors` 表

```sql
CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('human', 'ai-agent')),
  display_name TEXT NOT NULL,

  -- 人类成员字段
  email TEXT,
  communication_handle TEXT,   -- Slack handle / WeCom id / 企微 id

  -- AI agent 字段
  agent_model TEXT,            -- 'claude-code' / 'devin' / 'sweep' / 'custom'
  agent_endpoint TEXT,         -- 调用这个 agent 的 webhook URL
  agent_api_key_ref TEXT,      -- 密钥引用（不存明文）
  capabilities_json TEXT,      -- ["code","review","research","design"] 能处理什么
  context_window INTEGER,      -- token 上限，影响上下文注入量

  -- 共同字段
  autonomy_level INTEGER DEFAULT 0,  -- 0-5，对应 Part M.5 升级路径
  active BOOLEAN DEFAULT true,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### 所有引用 `owner: string` 的表，统一改为 `actor_id → actors.id`

```sql
-- tasks 表
ALTER TABLE tasks ADD COLUMN actor_id TEXT REFERENCES actors(id);
-- 旧 owner 字段迁移：人类成员自动创建对应 actor 记录，actor_id 指向它

-- assignments / standups / reviews 同理
```

#### Actor 无关的任务分配逻辑

```typescript
// 任务分配不再问"谁来做"，而是问"哪个 actor 最合适"
async function dispatchTask(task: Task, candidates: Actor[]): Promise<Actor> {
  const humanCandidates = candidates.filter(a => a.type === 'human');
  const agentCandidates = candidates.filter(a => a.type === 'ai-agent');

  // 判断哪类 actor 更适合这个任务
  if (task.requiresHumanJudgment || task.sensitivityLevel > 3) {
    return rankHumans(task, humanCandidates);
  }

  if (task.acceptance && agentCandidates.some(a => a.capabilities.includes('code'))) {
    return rankAgents(task, agentCandidates);  // 有 AC 且有 code agent → 可交给 agent
  }

  return rankHumans(task, humanCandidates);  // fallback
}
```

---

### Q.2 Communication Platform Adapter：WeCom 变成插件，不是核心

**原来的假设**：企业微信是唯一通知渠道，`wecom.js` 硬编码在业务逻辑里。

**新的假设**：系统工作在通信平台之上，任何平台都是一个 adapter。

#### Adapter 接口

```typescript
// notification/adapter.ts
export interface NotificationAdapter {
  readonly platform: string;                          // 'wechat-work' | 'slack' | 'feishu' | 'discord' | 'email'
  send(message: NotificationMessage): Promise<void>;
  sendInteractive(message: InteractiveMessage): Promise<InteractionResponse>;
  parseIncoming(raw: unknown): IncomingMessage | null; // 解析来自平台的输入
}

export interface NotificationMessage {
  text: string;
  markdown?: string;
  mentions?: string[];   // actor ids，adapter 负责映射到平台 handle
}

export interface InteractiveMessage extends NotificationMessage {
  choices: Choice[];     // e.g. ['1. 领取任务A', '2. 领取任务B']
  responseTimeoutSec: number;
}
```

#### Adapter 注册

```typescript
// notification/registry.ts
const adapters = new Map<string, NotificationAdapter>();

// 租户配置决定用哪个 adapter，可以同时注册多个
adapters.set('wechat-work', new WeComAdapter(config.wecom));
adapters.set('slack', new SlackAdapter(config.slack));
// ...

// 业务层只调这个，不知道底层是什么
export async function notify(tenantId: string, message: NotificationMessage) {
  const tenantAdapters = getTenantAdapters(tenantId);
  await Promise.allSettled(tenantAdapters.map(a => a.send(message)));
}
```

**对现有 `wecom.js` 的处理**：保留所有业务逻辑，把它包装成 `WeComAdapter implements NotificationAdapter`。现有行为不变，但调用方改成通过 registry 而非直接调用。

---

### Q.3 Agent Integration Protocol：AI agent 接入标准

这是愿景里"AI agent 作为第一类团队成员"的技术实现。

#### Agent 接入流程

```
1. 注册 agent
   POST /api/agents/register
   {
     name: "my-claude-code-agent",
     model: "claude-code",
     endpoint: "https://my-agent.example.com/webhook",
     capabilities: ["code", "review"],
     secret: "用于验签"
   }
   → 返回 agent_id，写入 actors 表

2. 任务分配给 agent
   → Hub 调 agent.endpoint
   POST agent.endpoint
   {
     task_id, title, acceptance,
     context: {                    // 从 project_memory 检索注入
       conventions: [...],
       past_decisions: [...],
       gotchas: [...],
       related_prs: [...]
     },
     callback_url: "https://hub/api/agents/callback"
   }

3. Agent 汇报进度
   POST /api/agents/callback
   {
     task_id, agent_id,
     event: "progress" | "completed" | "blocked" | "needs-human",
     payload: { message, artifacts, ac_status }
   }

4. Agent 完成，触发验收
   → emit task.completed-by-agent
   → 验收 worker 跑 AC checklist + 静态分析
   → 如验收通过，走 Part M.5 autonomy 积分
   → 如验收失败，emit task.returned-to-human
```

#### Agent Standup（agent 也汇报）

```typescript
// agent 的 standup 和人类一样走同一个 standup.submitted event
{
  actor_id: 'agent_claude_code_01',
  actor_type: 'ai-agent',
  date: '2026-05-21',
  completed: ['实现了 TRTC 入口组件，AC 全部通过'],
  in_progress: ['正在处理 PR #128 的 review 意见'],
  blocked: []   // agent blocked → 自动升级给人类
}
```

#### 晚会作战包新增 agent 视图

除了人类成员的 timeline，单独一栏展示"今日 AI agent 产出"：
- N 个任务由 agent 完成
- 人类 review 通过率
- Agent 自主决策了哪些事、请示了哪些事

---

### Q.4 多租户 Schema：从第一天预留

v2 是从单租户起步，但 schema 设计不能绑死。每张表加 `tenant_id`，索引加 `tenant_id` 前缀，查询层自动注入。

```sql
-- 每张核心表都加
ALTER TABLE tasks ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE actors ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE project_memory ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
-- ... 所有表同理

-- 所有索引加 tenant_id 前缀
CREATE INDEX idx_tasks_tenant_state ON tasks(tenant_id, state, project_id);
```

查询层封装：

```typescript
// db/tenant.ts
export function withTenant(tenantId: string) {
  return {
    tasks: () => db.selectFrom('tasks').where('tenant_id', '=', tenantId),
    actors: () => db.selectFrom('actors').where('tenant_id', '=', tenantId),
    events: () => db.selectFrom('events').where('tenant_id', '=', tenantId),
    // ...
  };
}

// 所有业务代码通过 withTenant(ctx.tenantId) 访问数据，不直接写 where
```

单租户自托管：`tenant_id = 'default'`，行为与现在一致。多租户云平台：`tenant_id = ${orgId}`，完全隔离。

---

### Q.5 更新后的路线图（16 周）

| 周 | 主题 | 关键交付 | 新增 vs 原计划 |
|---|---|---|---|
| W1 | **地基** | SQLite + actor 表 + tenant_id + p-queue | 新增 actor 表，tenant_id |
| W2 | **事件层** | EventBus + outbox + reducer | 同原计划 |
| W3 | **Fastify + Octokit + Adapter 层** | route 切 Fastify；NotificationAdapter 接口；WeComAdapter 包装 | 新增 adapter 架构 |
| W4 | **Agent Integration Protocol** | agent 注册 + 任务分配 + callback + standup | **全新** |
| W5 | **PR Prompt + RAG** | task 创建→PR 描述；M.2 project memory 冷启动 | 原 W4 + M.2 提前 |
| W6 | **Reviewer Map-Reduce** | tree-sitter + Semgrep；agent 输出验收协议 | 原 W5 + agent 验收 |
| W7 | **推荐三阶段** | features + ranker + explainer；actor-aware 推荐 | 原 W6 + actor 感知 |
| W8 | **三端同步 broker** | doc-sync；AC 双向；防循环签名 | 同原计划 |
| W9 | **Outcome Ledger** | M.1 ai_outcomes；agent outcome 观察 | 原 W7 |
| W10 | **Active Learning + 观察台** | M.4 + V5；agent 视图 | 原 W8 |
| W11 | **SPACE + 风险传播** | 健康度扩展；agent 纳入 SPACE 计算 | 原 W8 |
| W12 | **可观测性 + runbook** | ledger；监控；runbook | 原 W9 |
| W13 | **周期学习 batch** | M.3；ranker 权重自动调整 | 原 W11 |
| W14 | **Graduated Autonomy** | M.5；circuit breaker | 原 W12 |
| W15 | **多平台 adapter 扩展** | SlackAdapter / FeishuAdapter 实现 | **全新** |
| W16 | **公开 API + 云平台预备** | API 文档；多租户验证；外部 agent 接入测试 | **全新** |

**W4（Agent Integration Protocol）是全新增加的一周，也是愿景里最关键的一周。**
没有这一周，剩下所有工作都只是"更好的人类 PM 工具"，不是"混合团队操作系统"。

---

### Q.6 Part I 决策中因愿景而改变的选项

| 决策 | 原答案 | 新答案 | 原因 |
|---|---|---|---|
| 9. Hub 写 PR 的身份 | (a) cue-hub-bot GitHub App | **GitHub App，同时支持其他平台** | 不能只考虑 GitHub，agent 可能工作在任何 repo |
| 17. UCB1 探索机制 | ❌ 4 人团队不需要 | **✅ 需要** | 需要探索 AI agent 和人类的最优分工，单人类团队逻辑不适用 |
| 22. 10 周路线图 | 接受 10 周 | **接受 16 周** | 加了 agent integration + adapter + 多租户 |
| 23. 前端不动 | ✅ | **✅ 但 W4 后加 agent 视图** | 人类监督 agent 输出需要新的 UI paradigm |
| 新增 27. **Actor 系统** | — | ✅ W1 必做 | 愿景的技术核心 |
| 新增 28. **Platform Adapter** | — | ✅ W3 必做 | 通信平台无关是基本要求 |
| 新增 29. **Agent Integration Protocol** | — | ✅ W4 必做 | 没有这个，AI agent 不是第一类成员 |
| 新增 30. **Tenant_id 预留** | — | ✅ W1 必做 | 云平台是路线图，schema 不能绑死 |

---

## Part P · 三个核心承诺（回答原始疑问）

### 承诺 1：不再有"随手做的算法"

通过 **Part N.1** + **Part M.7（论文/OSS 参考表）** + **PR 强制检查** 保证。任何新算法没引用就拒绝合并。

### 承诺 2：不再三天两头出 bug / 生产事故

**不承诺 0 bug**（不可能），但承诺：
- M1-M5 这 5 类已知失败模式**结构上不可能再发生**
- 任何新 bug 都有**完整 audit trail**（events 表 + llm_calls 表），不需事后插桩
- 任何生产事故可通过**事件回放**恢复，不需手改 db
- 每个事故进 runbook，下次 5 分钟内可恢复

### 承诺 3：能持续作为生产工具存在

需要满足：
- ✅ Part O 完整落地（CI / 备份 / 监控 / runbook）
- ✅ Part M 累积 outcome 数据后系统自我提升
- ✅ Part N 工程宪章约束未来变更

只要三部分都到位，CUE Hub 就是**可无人值守长期运行的智能体**，PM 每天运营负担固定在 5-10 分钟（active learning + 审批高置信改动）。

---

## 下一步

1. 用户确认/修改 Part I 的 23 个决策
2. 用户确认 Part M (持续学习) + Part N (工程宪章) + Part O (生产化) 是否在范围内
3. 基于答案出 W1-W2 实施计划（含 schema 迁移脚本、reducer 骨架、actor 队列）
4. 那份计划可直接照着写代码
