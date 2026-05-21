# CUE 项目中枢 — 历次重写复盘

> 日期：2026-05-21
> 范围：自 2026-04 路径图迁移到 2026-05 PR 流后修复，共 5 个大重写
> 配套方案：`2026-05-21-v2-architecture-plan.md`
> 目的：在第 6 次重写动手前，把前 5 次反复爆同类 bug 的根因钉死

---

## 一图概览：5 次重写、commit 链与失败模式

| # | 重写 | 时间 | commit 数 | 计划文档 | 合并后修复数 | 主要失败模式 |
|---|---|---|---|---|---|---|
| 1 | 分工领取 progress 模型 | 2026-04 中 | 5 | 无 | 多次绕开 | M2 状态多源写无主 |
| 2 | 交付层 (deliverable-first) | 2026-05-10 ~ 12 | 9 | 有 (phase 0-2 plan) | **8 次** | M1 数据迁移无事务 |
| 3 | AI PM Sprint 1.5a | 2026-05-18 ~ 19 | 13（6 阶段） | 有 (spec + plan) | 2 次（idempotency / socket leak） | M4 LLM 路径独立 bug |
| 4 | PR 流（阶段 7） | 2026-05-20 | 14 | 有 (spec + 18 task plan) | 阶段 8 整个 | M3 LLM 散落无账本 |
| 5 | 阶段 8 token 泄漏修复 | 2026-05-20 ~ 21 | 5（debug 三连） | 无 | 三端同步设计稿（推迟） | M3 + M5 没有事件层 |

**核心观察**：流程越规范，修复数越少；但即便最规范的 AI PM Sprint 1.5a 仍漏掉 idempotency 和 socket leak —— 这两类是**运行时 bug**，code review 看不出来，只能靠地基（事务/事件）兜底。

---

## 重写 #1：分工领取 progress 模型（最隐蔽的一次）

### commit 链

```
902c90d fix: 未领取任务一律 owner='待认领'，LLM 建议归到 suggestedOwner
640fdbb fix(assignments): populate acceptance criteria
5804402 fix(tasks): treat ai estimate as automatic progress
9993fef fix(tasks): separate automatic and manual progress
67dffbf fix(tasks): clarify ai and confirmed progress
51c4652 fix(assignments): link claimed tasks to detail
5d50f75 fix(assignment): 认领任务只显示当前登录用户，管理员保留全员视图
```

### 表面问题
- 任务进度数字"莫名其妙变了"
- 用户领取后看不到自己领的
- AI 自动估算和用户手动改的进度互相覆盖

### 实际根因
**`task.progress` 同时被 3 个源写入，没有"哪个 source 有权写"的规则。**

证据：`5804402` 把 AI estimate 标记为 automatic、`9993fef` 把 automatic 和 manual 拆成两个字段、`67dffbf` 又改名为 ai/confirmed —— 这是同一个问题被改了 3 遍。**因为没有状态机说明"AI 估算只能写 ai_progress；用户手改只能写 confirmed_progress；对账只能写 verified_progress"**，每次出 bug 都重新拼字段名而不是建模。

### v2 方案怎么避免
- Part D 新增 `state/taskMachine.ts` 用枚举状态机
- Part E 的 `tasks.progress` 是 derived 字段，由 reducer 从 `progress_events` 表聚合算出
- 任何写 progress 的调用必须 emit `task.progressed` 事件并标 source

---

## 重写 #2：交付层 (deliverable-first model) — 失败模式最完整的样本

### commit 链（5 月 10-12 三天，9 个修复）

```
a94f3b4 feat: 将路径图切到交付项数据流
42811e2 feat: migrate store deliverable model
dcb0e6a feat: expose deliverable progress aggregation
55630f3 feat: add phase 2 explicit binding engine
cd5b796 feat: add deliverable-first docs sync
─── 切换完成，开始救火 ───
86ee089 fix: 任务去重强化 + 存量脏数据清洗接口
0b37256 fix: 跨节点污染防护 + 模糊近似去重
25d6ca2 fix: 导入时模糊去重 + deliverable 阶段自动映射
bfb0b80 fix: 重置路径图后幽灵节点污染 + 全量任务重绑
0d0bcc4 fix: 杜绝幽灵 deliverable + sync-docs 模糊去重 + 5 个回归测试
4a22dbd fix: deliverable 分阶段 LLM 权威映射 + 产品端硬规则 fallback
a656a09 fix: LLM 误分阶段校正 + 每个 deliverable 至少导入 1 个代表任务
25fc938 refactor: phase 匹配改为项目无关 — 靠 LLM productKeywords
d7963f5 fix(import-docs): 重复任务补绑 deliverableId 必须先通过可信度校验
```

### 表面问题
- 重置路径图后还有"幽灵"deliverable 残留
- 同一交付项被 LLM 分到不同 phase（每次解析飘）
- 跨 deliverable FK 污染（task.deliverableId 指向已删的节点）
- 模糊命名差异（"iPad 老师端开课" vs "iPad 端开课"）当成两个

### 实际根因
1. **数据迁移不是事务**：`store.js` 的 `migrateStore` 是字段补全脚本，不是 schema migration。重置 → 重导入路径里，**旧 task 的 deliverableId 没有 FK 约束，指向已删的 deliverable 节点**，前端按 FK 渲染就出现幽灵。
2. **LLM 是分类器而不是查询器**：phase 匹配最初硬编码 TRTC/iPad（`25fc938` refactor），换项目即失效。改成 LLM productKeywords + 硬规则 fallback，但 LLM 输出不稳定，每次飘。
3. **去重逻辑滞后于写入**：每次 sync-docs 都先写后查，等发现重复再清洗，**没有"写入前 normalize + unique 索引"**。

### 教训
**第 5 次 fix `0d0bcc4`（"杜绝幽灵 deliverable + 5 个回归测试"）写了 156 行回归测试** —— 但这些测试都是**针对前面 4 次 fix 没修干净的具体场景**，不是预防未来同类问题的。这是典型的"测试驱动救火"，不是测试驱动开发。

### v2 方案怎么避免
- Part E SQLite `pull_task_link` / `tasks.project_id NOT NULL` 等用真 FK + UNIQUE 约束
- 数据迁移走 `db/migrate.ts` 真 migration（带版本号、可回滚）
- LLM 输出不直接落 store，先进 `events` 表 + reducer 做去重 + FK 校验
- 重置不是"删数组"，而是"emit `project.reset` event → reducer 处理级联"

---

## 重写 #3：AI PM Sprint 1.5a — 流程最规范的反例

### commit 链

```
8f95c38 docs(ai-pm): Sprint 1.5a design spec + live progress board
a887d11 docs(ai-pm): spec v2 — fail-loud LLM + aiPromptTraces
8100b37 plan(ai-pm): Sprint 1.5a implementation plan (8 tasks across 6 phases)
d3aaf25 feat(ai-pm): Phase 1 — store schema
01bba95 feat(ai-pm): Phase 2 — dailyTaskSuggester service
39cf85a refactor(ai-pm): address Task 2.1 code review notes
dd233cb feat(ai-pm): Phase 3 part 1 — recommendationRoutes
7074c1e feat(ai-pm): Phase 3 part 2 — wire into index.js
53bf845 refactor(ai-pm): address Task 3 code review notes
e2fd9e2 feat(ai-pm): Phase 4 — scheduler 17:45 batch generates suggestions
a2f1c2a feat(ai-pm): Phase 5 part 1 — meeting tab panel HTML/CSS
b13c639 feat(ai-pm): Phase 5 part 2 — renderMeetingRecommendations + events
37b5785 docs(ai-pm): mark Sprint 1.5a thin slice complete
─── 上线 / 发现 bug ───
d77a7c4 fix(ai-pm): make POST /recommendations/:id/accept idempotent for same user
a1cdcc9 fix(ai-pm): close Promise.race socket leak with real AbortController
```

### 流程对照
- ✅ spec 写了（含 v2 修订）
- ✅ implementation plan 写了（8 task / 6 phase）
- ✅ 每 phase 一 commit
- ✅ phase 间 code review（Task 2.1 / Task 3 都有 review notes）
- ✅ 进度文档 (AI-PM-PROGRESS.md) 每 phase 更新

### 还是漏了两个 bug

**bug 1（`d77a7c4` idempotency）**：同一用户重复点 ✓，POST `/accept` 路由 fallthrough 创建了重复 assignment + 第二个 200 响应。

> 注：这个 bug 是 e2e smoke 才暴露的 —— "cross-user 409 路径写了 / same-user 重复路径忘了"。code review 看不出来，因为单元测试看不到并发请求。

**bug 2（`a1cdcc9` socket leak）**：`Promise.race` 超时 reject 后，底层 Anthropic HTTPS 请求仍在跑，直到 SDK 自己的 10 分钟超时 → zombie 套接字堆积。

> 注：这个 bug 是定时器路径（17:45 批量预生成）独有的。即便单条 e2e 测试也跑不出来，必须真跑几天才能看到生产环境的 socket 数飙升。

### 实际根因
**LLM 路径上的并发 / 资源管理 bug 永远是"运行时独有"**，规范流程 + code review 救不了。

### v2 方案怎么避免
- Part D `events/bus.ts` 把所有写操作变成 event → reducer 单写者，**结构上就不可能产生 duplicate assignment**（reducer 看到同源 event 走 idempotency 表）
- Part B 提到的 `p-queue` 串行化 + `AbortSignal` 是底层基础设施统一处理，不需要每个 worker 各自实现 AbortController
- Part E `llm_calls` 表强制记录每次调用的 latency / cache_hit，socket 异常立即可观测

---

## 重写 #4：PR 流（阶段 7）— 计划最详细

### commit 链

```
5f3d05a docs: 新增 PR 流全面切换设计规格文档
0c4181c docs: 新增 PR 流迁移实施计划（18 个 Task，6 个 Phase）
c974afc feat: store 迁移 — 新增 pulls/bypasses 集合
7da5c0e feat: 新增 PR 模板和 pr-agent.yml skeleton
78d9976 feat: githubApi 新增 fetchProjectPRs / fetchPRDetail
3e2cb45 feat: 新增 prAgentParser
d80c7e2 feat: 新增 pullPipeline
4c56ba9 feat: 新增 pullRoutes
064994a feat: webhookRoutes 新增 PR/bypass 端点
4d1def4 feat: githubSync 定时同步加入 PR 分支
965dad6 feat: server/index 注册 pullRoutes
6c2b302 feat: 晚会对账优先 PR 合规
7ca1251 feat: riskEngine PR 卡 48h 风险
d7fbc6c feat: 企微作战包加入 PR 汇总
fee5cdb / e605bb2 / c445562 feat: 前端 PR 视图
1aca21a feat: scheduler bypass 24h 告警
6f0c35c feat: main-push-policy.yml 检测直推
3e76c91 feat: 激活 pr-agent.yml — Phase 2 正式开启
9ec1af6 merge: PR 流全面切换 → main
3754e6a docs: 新增 PR-WORKFLOW.md 团队使用说明
```

### 表面看：完美执行
spec → plan → 18 个 task 逐个落地 → 团队文档 → 激活 PR-Agent。

### 实际问题：merge 当天就开始爆 token

`3e76c91`（5/20 激活）→ `b82cbb2`（5/20 跳过未变化 PR）→ `3ea94e2`（5/21 加 sync-trace）→ `0ba60a1`（5/21 加 LLM_DRY_RUN）→ `078f01f`（5/21 webhook 实时同步）。**激活当天到次日凌晨 4 个修复 commit。**

### 实际根因
1. **`githubSync.js` 定时同步是 fire-and-forget**，每 10 分钟把所有项目近 7 天 PR 全部跑一遍 buildHubReview，每个 PR 一次 LLM 调用。
2. **`pullPipeline` 没有去重**：同一个 PR 状态没变也照样进 LLM。
3. **LLM 调用没有账本**：要靠新写 `syncTrace.js` 临时插桩才能定位"几千次调用"是哪来的。
4. **缓存策略后置加**：等到 `b82cbb2` 才加 `unchanged → skip LLM`。

### 真正的 takeaway
**`docs/superpowers/specs/2026-05-21-three-way-sync-design.md` 里写了**：

> 第七阶段完成了"把 PR 数据接进 Hub"，但下游消费者（晚会、风险、阶段、语义）仍在消费 commit，PR 流成了孤岛。

PR 流迁移**实际上是双写**：commit 流没拆，PR 流加上去 —— 两份数据源、两份 LLM 调用、两份去重逻辑。

### v2 方案怎么避免
- Part F 事件总线：PR webhook 直接 emit `pr.opened/synchronized/merged`，**reviewer worker 订阅 event 自带幂等**
- Part D 删除 `githubSync.js` 定时同步，用 BullMQ idempotent job + Octokit
- Part E `llm_calls` 表从第一天就在，不用事后插桩

---

## 重写 #5：阶段 8 token 泄漏（debug 三连）

### commit 链

```
b82cbb2 fix: pullPipeline 跳过未变化 PR 的 LLM review
3ea94e2 debug: 新增 sync-trace 调用追踪
7219d89 merge: PR LLM 调用缓存 + sync-trace 调试
0ba60a1 debug: 新增 LLM_DRY_RUN 开关
a64d2ab merge: LLM_DRY_RUN 拦截开关
078f01f feat: webhook 驱动 PR 实时同步，替代 10 分钟轮询
```

### 真实顺序（看 timestamp）
- 5/20 22:38 加 unchanged skip
- 5/21 00:01 加 sync-trace
- 5/21 00:20 加 LLM_DRY_RUN（夜里两点继续修）
- 5/21 01:07 webhook 实时同步

凌晨连开 6 小时。

### 根因
**LLM 调用栈没有可观测性**。`syncTrace.js` 是"出事了才插的"，包括抓 `new Error().stack.split('\n').slice(2, 6)` 来定位调用源。**这种插桩在 v2 方案 Part E `llm_calls` 表里是默认能力**。

### 同时也暴露了
- **没有事件层**：本应该是 PR webhook 来一次跑一次的工作，错放在定时轮询里
- **没有写入串行化**：webhook 触发的 `upsertPullFromWebhook` 和 `syncGitHubProjects` 定时任务可能同时写同一条 pull，依靠 in-memory cache 的 last-writer-wins 在 webhook 风暴时会丢更新

---

## 五种失败模式（M1-M5）汇总

| 代号 | 模式 | 出现在 | v2 方案对应措施 |
|---|---|---|---|
| **M1** | 数据迁移不是事务，新模型创建"幽灵数据" | 交付层 (#2) | SQLite FK + 真 migration + reducer 校验 |
| **M2** | 状态多源写入，没有"谁有权写"的规则 | 分工领取 (#1) | XState/枚举状态机 + event source 标记 |
| **M3** | LLM 调用散落各处，没有调用账本 | PR 流 (#4)、阶段 8 (#5) | `llm_calls` 表 + 路由器统一拦截 |
| **M4** | LLM 路径独有的运行时 bug（并发/资源），单元测试看不见 | AI PM (#3) | 单写者 actor + AbortSignal 统一处理 |
| **M5** | 没有事件层，新数据流接入只能"双写" | PR 流 (#4)、阶段 8 (#5) | EventBus + outbox + worker 订阅 |

---

## 重写流程上的反模式

复盘 commit 历史还发现 4 个非技术性的反模式，下次必须避免：

### R1：把"重置/迁移"当作 import 路径
> `bfb0b80` "重置路径图后幽灵节点污染"

每次出"重置后还有残留"，本质都是 reset 逻辑写在 import 路径上的"if 第一次 then 创建 default"分支，不是独立操作。

**规则**：reset 必须是独立 event + reducer，不能耦合在 import 里。

### R2：测试是"修哪写哪"
> `0d0bcc4` 5 个回归测试都是针对前 4 次 fix 的具体场景

测试代码本身在追 bug，没有抽象出"任何 deliverable 操作后，所有 task.deliverableId 必须指向存在节点"这样的不变量。

**规则**：每个新数据关系，先写 invariant 测试（FK 一致性、唯一性），再写业务测试。

### R3：refactor 撤销前面 fix 的硬编码
> `25fc938` refactor 删掉了前面 fix 加的 TRTC/iPad 硬规则

意味着 fix 用"先硬编码兜底" → refactor 用"LLM productKeywords + 硬规则 fallback" → 最终 fallback 又退化成硬编码的循环。

**规则**：硬编码 fallback 写之前先问"项目无关版本是否可做"，避免来回拆。

### R4：合并到 main 前没有用过 LLM_DRY_RUN
> 阶段 8 的 LLM_DRY_RUN 是出事后才发明的

调试开关应该在功能开发期就存在，不是事后补。

**规则**：每个 LLM 调用点必须支持 `purpose: 'review' | 'planner' | 'doc-sync' | ...` 标签，路由器在所有调用前抓取（参见 v2 Part E `llm_calls.purpose`）。

---

## 这次（v2 方案）能不能跳出循环的判断标准

读完上面应该清楚：**前 5 次重写每次都解决了表面问题，但 M1-M5 这五个根因从来没被触碰过**。所以无论第 6 次重写做得多漂亮，只要还在 `db.json + updateStore + setInterval` 这个底盘上，未来一定还会出同类 bug。

v2 方案的关键判定：

| 提议 | 解决哪个根因 |
|---|---|
| SQLite + Kysely + FK | M1 |
| p-queue 单写者 actor | M2、M4 |
| EventBus + outbox + events 表 | M2、M5 |
| `llm_calls` 表 + LLM 路由器 | M3、M4 |
| Octokit + BullMQ idempotency | M3、M5 |
| 任务状态机枚举 + reducer | M1、M2 |

**Part I 的 23 个决策，凡是直接对应上面这 6 项的（决策 1/3/5/7/8/19/21）属于"基础设施类"，建议优先 ✅；剩余偏算法/范围，可以再讨论。**

---

## 给下次方案讨论的建议

1. 先把"是否同意 M1-M5 是真问题"的判断对齐，再讨论方案
2. 把 v2 方案 Part I 的决策按"基础设施 / 算法 / 范围"分三组分别投票
3. W1-W2 完成（地基）即可独立验证：用 sync-trace 历史回放是否能在新系统重建出一致状态
4. 后续任何重写都必须先看：是不是又在动业务层、地基有没有变化
