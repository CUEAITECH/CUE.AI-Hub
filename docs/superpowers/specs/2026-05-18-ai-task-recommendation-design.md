# AI 任务推荐功能 — 设计文档

**版本：** Sprint 1.5a（thin slice）
**日期：** 2026-05-18
**目标：** 让团队成员在 18:00 晚会期间通过"做选择题"代替"手动输入"领取明日任务，同时建立 AI 推荐准确率的 PMF 数据闭环

---

## 1. 背景与目标

### 1.1 现状

CUE.AI 团队的晚会工作流（18:00-19:00）目前依赖手动操作：每人自己从任务池里筛选合适的任务、手动填表"会后领取"。痛点：
- "会后领取" panel 几乎没人用，团队主要靠群里口头分配
- AI 已经在做很多判断（sync-docs 导入任务、estimateTasksProgress、autoClose），但没有反馈机制衡量准确率
- PMF 验证缺数据：哪些 AI 推荐被采纳了？采纳后真的完成了吗？

### 1.2 目标

把"团队成员输入文本 → AI 解析"反过来变成"AI 出选项 → 团队做选择题"，并通过这个过程：
1. 降低晚会任务领取的认知负担
2. 建立"AI 推荐 → 被接受/被忽略"的端到端 PMF 数据闭环
3. 为后续 prompt 调优 / fine-tune 沉淀真实反馈数据

### 1.3 非目标

- ❌ 替代团队的协商决策（推荐只是建议，不是强制）
- ❌ AI 自动创建新任务（限定从现有 `store.tasks` 池筛选）
- ❌ 取消手动"会后领取"路径（thin slice 暂时让位，后续看反馈决定保留方式）

---

## 2. 数据模型

### 2.1 新增 store 字段

```js
store.dailyTaskSuggestions = {
  '<forDate YYYY-MM-DD>': {                  // 推荐对应的工作日（通常是明天）
    '<userId>': {
      generatedAt: '<ISO datetime>',          // 生成时刻
      generatedBy: 'scheduler' | 'manual',    // 触发源
      pool: {
        eligibleCount: 12,                    // 当时候选池大小
        totalEvaluated: 12                    // LLM 实际评估的数量
      },
      candidates: [
        {
          taskId: 'task_xxx',
          score: 87,                          // 0-100
          reason: '<40 字内一句话>',           // AI 给的推荐理由
          hint: '<60 字内实施提示>',           // AI 给的实施建议
          status: 'pending' | 'accepted' | 'superseded',
          actedAt: null | '<ISO datetime>',   // 用户操作时间（accepted）
          acceptedAssignmentId: null | '<assignment id>',  // 桥到 assignments 表
          traceId: 'trace_xxx'                // 桥到 aiPromptTraces，便于 PMF 归因
        }
        // 共 ≤ 3 个，按 score 降序
      ]
    }
  }
};
```

### 2.2 状态语义

- **pending** — 默认，未操作
- **accepted** — 用户点 ✓ 我做，已创建对应 assignment
- **superseded** — 同用户后续刷新覆盖了前一批（保留历史用于 PMF 分析"AI 推荐质量"）

### 2.3 跨表关联

- `assignments` 表新增 2 字段：`aiSuggested: boolean` 和 `aiSuggestionRef: { date, userId, taskId } | null`
- 接受推荐时原子创建 assignment 并写回 `acceptedAssignmentId`
- `store.tasks` 表无新字段（已有 `aiSuggestedAt` 来自 sync-docs 路径）

### 2.4 supersede 排除规则

同一用户同一 `forDate` 下 `status=superseded` 的 candidates，下次刷新时**从该用户的候选池里排除**。跨日 reset，不带历史。

### 2.5 LLM 调用日志（解锁 prompt 迭代）

```js
store.aiPromptTraces = [
  {
    traceId: 'trace_<random>',
    feature: 'daily-task-suggestion',     // 留作未来其他 AI feature 复用
    userId: '<user id>',
    forDate: '2026-05-19',
    triggeredBy: 'scheduler' | 'manual',
    systemPromptHash: '<sha256 8 字符>',    // 标 prompt 版本，跨期对比
    userPromptSnapshot: '<完整输入文本>',    // 脱敏后保存
    rawOutput: '<LLM 返回原文>',
    parsedCandidates: [                    // 解析成功的部分
      { taskId, score, reason, hint }
    ],
    parseError: null | '<错误信息>',
    durationMs: 4523,
    timestamp: '<ISO>'
  }
]
```

**保留策略：** 最近 200 条（约 1-2 个月，4 人团队），更老的自动清理。
**追加更新：** 不直接挂用户动作，从 `dailyTaskSuggestions` 的 candidates.status 反查即可（通过 traceId 关联）。

### 2.6 migrateStore 默认

```js
draft.dailyTaskSuggestions = draft.dailyTaskSuggestions || {};
draft.aiPromptTraces = draft.aiPromptTraces || [];
```

assignments 表的新字段在 normalize 时填默认 `false` / `null`，老数据零迁移。

---

## 3. API 设计

### 3.0 鉴权与身份

所有 3 个 HTTP 端点都需要登录。从 session token 解出 `sub`（user id），再用 `store.users.find(u => u.id === sub)` 拿到用户对象。
- 推荐数据按 `user.id` 索引
- 创建 assignment 时 `owner` 字段写 `user.name`（与现有 assignment 语义一致）
- 未登录 → 401

### 3.1 GET `/api/recommendations?date=YYYY-MM-DD`
**返回：**
```json
{
  "date": "2026-05-19",
  "generatedAt": "2026-05-18T17:45:03Z",
  "generatedBy": "scheduler",
  "candidates": [
    {
      "taskId": "task_xxx",
      "task": { "id": "task_xxx", "title": "...", "owner": "待认领", "..." },
      "score": 87,
      "reason": "...",
      "hint": "...",
      "status": "pending",
      "acceptedBy": null   // 任务被其他人接受时填对方姓名（用于"已被领取"灰态）
    }
  ],
  "pool": { "eligibleCount": 12, "totalEvaluated": 12 }
}
```

无推荐时：`candidates: []`，`message: '今日推荐尚未生成'`。

### 3.2 POST `/api/recommendations/refresh`

**鉴权：** 同上
**body：** `{ "date": "2026-05-19" }`
**行为：** 对当前用户在该 date 触发重新生成。老 candidates 全标 `superseded`，新的覆盖。
**返回：** 同 GET 的形态，包含新 candidates。
**Timeout 策略：** 同步等 LLM 最多 12s（实际 5-8s）。超时返回 503，前端显示"AI 暂不可用"提示（不做规则降级，详见 §4.4）。前端用 spinner 覆盖等待。

### 3.3 POST `/api/recommendations/:taskId/accept`

**鉴权：** 同上
**body：** `{ "date": "2026-05-19" }`
**行为（原子）：**
1. 加载 store，找 task。
2. 如果 `task.owner !== '待认领'`：return 409 + `{ "error": "task already taken", "acceptedBy": "<name>" }`
3. 否则：
   - 设 `task.owner = <currentUser.name>`
   - 创建 assignment：`{ date, owner: <name>, taskId, taskTitle, aiSuggested: true, aiSuggestionRef: { date, userId, taskId } }`
   - 当前用户该 date 的对应 candidate：`status='accepted'`, `actedAt=now`, `acceptedAssignmentId=<assign.id>`

**返回：** `{ "assignment": {...}, "candidate": {...} }`

### 3.4 内部端点（非 HTTP）

`generateDailyTaskSuggestions(forDate, userId, store)` — service 函数，调度器和 refresh API 都调它。不暴露 HTTP，避免越权批量触发 LLM。

---

## 4. 推荐引擎逻辑

### 4.1 文件结构

新文件：`server/services/dailyTaskSuggester.js`
- `export async function generateDailyTaskSuggestions(forDate, userId, store)` — 主入口
- `function buildUserContext(userId, store)` — 收集用户特征（最近 14 天 commits / 当前在做的任务 / 历史模块）
- `async function llmRankTasks(eligible, userContext, store)` — LLM 排序
- `function ruleScore(task, userContext)` — 规则降级评分

### 4.2 召回（规则层，无 LLM）

```js
const eligible = store.tasks.filter(t =>
  t.status === 'pending'
  && (t.owner === '待认领' || !t.owner)
  && !excludedByPreviousSupersede(forDate, userId, t.id, store)
  && !alreadyAcceptedByOthers(forDate, t.id, store)
);
```

候选池为空 → 返回 `{ candidates: [], pool: { eligibleCount: 0, ... } }`。

### 4.3 LLM 排序

**调用模式：** 独立调用，每用户 1 次（4 人 = 4 次/天）。

**System prompt（静态，命中 prompt cache）：**
```
你是研发任务匹配助手。基于成员的最近工作 + 任务的技术栈，从候选池里给出 top 3 推荐。

输入：
- 候选任务列表（id / title / acceptance / sourceDoc / deliverable.title）
- 当前成员 profile（姓名 / 最近 commits / 当前在进行任务 / 历史擅长模块）

输出 JSON：[{ taskId, score: 0-100, reason: 一句话(<40字), hint: 实施提示(<60字) }, ...]
按 score 降序，至多 5 个（前端取 top 3）

规则：
- score ≥ 70 = 强匹配
- 50-69 = 中匹配
- < 50 不输出
- reason 必须具体引用 commit 文件或任务关键词，禁止"非常合适"等空话
```

System prompt 上有 `cache_control: { type: 'ephemeral' }`。

### 4.4 LLM 失败处理：fail loud，不做规则降级

**决策（PMF 阶段）：** LLM 不可用时直接报错，让用户立刻知道而不是用劣化兜底掩盖问题。

理由：规则推荐质量差会污染 PMF 数据（"接受率低"分不清是 LLM 差还是规则差），且让团队对 AI 推荐失去信心。宁可暂时没推荐也不要假推荐。

**实现：**
- `generateDailyTaskSuggestions` 失败时抛 `LLMUnavailableError`，调用方负责处理
- 调度器 17:45 失败 → 日志 + 企微告警（推到机器人）："今日 AI 推荐生成失败，请人工排查 ANTHROPIC_API_KEY 或服务可用性"
- 手动刷新 API 失败 → 返回 503 + 错误消息，前端 UI 显示红色 banner："AI 推荐暂不可用：<错误>。可手动从任务池领取，或稍后重试。"
- 数据：失败时不写 `dailyTaskSuggestions[forDate][userId]`，避免污染历史

**何时重新引入规则兜底：**
- PMF 验证后，LLM 失败成为常态（成本/可用性问题）才考虑
- 届时规则版作为独立的 "fallback mode"，UI 明确标"由规则推荐"，与 LLM 推荐区分

### 4.5 LLM 调用 trace 记录

`generateDailyTaskSuggestions` 内部：每次 `callClaude` 完成后（成功或解析失败都记），追加一条到 `store.aiPromptTraces`。

```js
await updateStore((draft) => {
  draft.aiPromptTraces = draft.aiPromptTraces || [];
  draft.aiPromptTraces.unshift({
    traceId, feature: 'daily-task-suggestion',
    userId, forDate, triggeredBy,
    systemPromptHash: sha256(SYSTEM_PROMPT).slice(0, 8),
    userPromptSnapshot, rawOutput,
    parsedCandidates, parseError,
    durationMs, timestamp
  });
  draft.aiPromptTraces = draft.aiPromptTraces.slice(0, 200);  // 保留最近 200 条
  return draft;
});
```

candidate 数据里加 `traceId` 字段（在 §2.1 candidates 内补一行），方便从用户动作反查 trace。

### 4.6 forDate 默认值

- 调度器 17:45 自动跑：`forDate = todayText()` + 1 天（明天）
- 用户手动刷新：`forDate = 用户传的 date`（前端默认 = 明天）

---

## 5. UI 改造范围（thin slice）

### 5.1 改动文件

| 文件 | 改动 |
|---|---|
| `index.html` | 替换 `#meetingAssignmentList` 那段 panel HTML |
| `src/app.js` | 新增 `renderMeetingRecommendations()` + bindEvents 加 ✓ 接受 + 🔄 刷新事件 |

### 5.2 新 panel 布局

替换现有"会后领取" panel 的 dropdown 表单，改成：

```
┌──────────────────────────────────────────────────────┐
│ 🤖 AI 今日推荐 · 田家铭          [🔄 刷新]           │
│ 为你匹配 3 个任务                                    │
├──────────────────────────────────────────────────────┤
│ ① 完成 GitHub 同步重构                  [✓ 我做]    │
│    [87 分] 你最近 5 个 commit 在 server/services/... │
│    💡 依赖现有 callClaude，预计 2-3h                │
├──────────────────────────────────────────────────────┤
│ ② 🔒 修复登录页 bug                       [—]       │
│    已被 罗子宽 领取                                  │
├──────────────────────────────────────────────────────┤
│ ③ 补充阶段 5 验收文档                   [✓ 我做]    │
│    [62 分] 你之前写过类似的 stage 文档              │
│    💡 参考 docs/阶段4验收.md 结构                   │
├──────────────────────────────────────────────────────┤
│ 生成于 17:45 · 候选池 12 个任务                     │
└──────────────────────────────────────────────────────┘
```

### 5.3 交互

| 动作 | 行为 |
|---|---|
| 点 ✓ 我做 | POST accept → 卡片变 ✓ 已领取，当前用户其他卡片仍可见 |
| 点 🔄 刷新 | POST refresh → 5s spinner → 三张卡片刷新 |
| 任务已被其他人领取 | 显示 🔒 + 灰态 + 按钮 disabled（不实时推送，刷新页时更新） |

### 5.4 其他 meeting tab panel 不动

对账、出勤、会后跟进、报告正文 5 个 panel 保持原状。

---

## 6. 验证方案

### 6.1 Per-task

```bash
node --check <每个改动的 .js 文件>
```

### 6.2 单元 smoke

```bash
node -e "
import('./server/services/dailyTaskSuggester.js').then(async (m) => {
  const { loadStore } = await import('./server/store.js');
  const store = await loadStore();
  const result = await m.generateDailyTaskSuggestions('2026-05-19', 'user_jiaming', store);
  console.log(JSON.stringify(result, null, 2));
});
"
# 期望: 3 个 candidate + score + reason + hint
```

### 6.3 API smoke

- GET `/api/recommendations?date=2026-05-19` → 200 + JSON
- POST `/api/recommendations/refresh` body `{date}` → 200 + 新 candidates
- POST `/api/recommendations/:taskId/accept` body `{date}` → 200 + assignment
- 重复 accept → 409 + acceptedBy

### 6.4 调度器测试

临时把 `MEETING_HOUR` 调到当前小时 + 2 分钟，看日志 `[Scheduler] 推荐已生成 N 个用户`。

### 6.5 浏览器手动

切到晚会 tab → 看到新 panel → 点 ✓ → 卡片变化 → 切到我的任务 → 看到新行。

### 6.6 Phase 完成标准

每 Phase 必须：
- [ ] `node --check` 全过
- [ ] 启动 smoke 无报错
- [ ] 至少 2 个对应 API 端点 curl 返回符合预期
- [ ] git commit message 清晰

---

## 7. 实施 Sprint 切分

### Sprint 1.5a（thin slice）— 本 spec 范围

约 4-5 天，6 个 Phase：
1. 数据模型 + migrateStore
2. 推荐引擎 service（含 LLM + 规则降级）
3. API endpoints（3 个 HTTP）
4. 调度器 17:45 接入
5. 前端 panel 改造
6. E2E smoke + 修 bug

### Sprint 1.5b（看反馈再做）

- "换一个" / "看全部" / "今天没任务" 三个兜底出口
- 估时 3-4 天

### Sprint 1.5c（看反馈再做）

- 全员视图切换
- 概览页时间敏感 banner
- WeCom 适配（推送 + 数字回复接受）
- 估时 1 周

---

## 8. PMF 指标 + Prompt 迭代方法论

### 8.1 通过 store.dailyTaskSuggestions 直接算的指标

| 指标 | 计算 |
|---|---|
| 接受率 | `count(status=accepted) / count(status in [accepted, pending])` |
| 刷新率 | `count(superseded) / count(总 candidates)` |
| 池子健康度 | 每日 `pool.eligibleCount` 趋势 |
| 任务完成率 | `assignments where aiSuggested=true and status=已完成` |
| 撤销率 | accept 后 24h 内人工改 task owner 或撤销的比例 |

### 8.2 通过 store.aiPromptTraces 做 prompt 迭代

每周 review：
1. **最差 10 条** — 候选全被 superseded 或 accept 后撤销的 trace
2. **最好 10 条** — 接受后任务真完成的 trace
3. 看 `userPromptSnapshot` 找模式：
   - 是 user context 太薄？ → 加字段
   - 是 task feature 不够？ → 加字段
   - 是 system prompt rule 漏了？ → 加 rule（同时 systemPromptHash 变化，可对照前后周指标）

每次只动 1 个杠杆（system prompt / user context / task features），留对照组。

### 8.3 短期 vs 中期 vs 长期迭代

| 阶段 | 方法 | 成本 |
|---|---|---|
| Sprint 1.5a（本期） | trace 落库 + 周手动 grep | 0 额外（trace 加进 spec） |
| Sprint 1.5b | refresh 弹 1-click rubric（太难/不熟/冲突/其他）| 1 天 |
| 成熟期 | A/B 测试基础设施 + automated eval | 1+ 周 |

每周自动生成"AI 推荐周报"推到企微（Sprint 1.5c 范围）。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 调用失败 | 不降级。前端红色 banner "AI 暂不可用"；调度器失败推企微告警；保留 PMF 数据纯净度（详见 §4.4） |
| 候选池为空 | 显示"任务池暂时没有匹配你的任务，建议刷新 docs"，附"同步 docs"按钮 |
| 推荐质量差 | PMF 指标里"刷新率"暴露问题；prompt 迭代 |
| 多人同时点同一任务 | 409 + UI 灰态 + 自动刷新 |
| 17:45 调度器漏跑 | 用户打开晚会页时若 candidates 为空且 forDate >= today，自动触发 refresh |
| 用户 profile 不准（commits 太少） | 退化到只用任务的 deliverable / sourceDoc 信号 |
