# AI 任务推荐 Sprint 1.5a — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 18:00 晚会期间的任务领取从"手动输入"改成"AI 出 3 个选项 → 团队点 ✓"，同时建立 PMF 反馈闭环（接受率 + LLM trace 日志）。

**Architecture:** 新增 `dailyTaskSuggester` service 用 Claude 给每用户独立排序候选任务；3 个新 HTTP 端点（get/refresh/accept）；调度器 17:45 批量预生成；前端只改 meeting tab 的"会后领取" panel；LLM 失败 fail loud（不降级）。

**Tech Stack:** Node.js ES Modules, Anthropic SDK (existing `callClaude`), 原生 HTTP, JSON store, 无测试框架（用 `node --check` + curl smoke）

**Spec:** `docs/superpowers/specs/2026-05-18-ai-task-recommendation-design.md`

**Work directory:** `/Users/dirtortian/Documents/GitHub/CUE-Project-Hub/.claude/worktrees/quirky-moser-d4bda9/`

**Branch:** `claude/quirky-moser-d4bda9`

---

## File Map

| 文件 | 操作 | 责任 |
|------|------|------|
| `server/store.js` | Modify | `migrateStore` 加 `dailyTaskSuggestions` + `aiPromptTraces` 默认值 |
| `server/services/dailyBrief.js` | Modify | `normalizeAssignment` 加 `aiSuggested` + `aiSuggestionRef` 字段 |
| `server/services/dailyTaskSuggester.js` | Create | 推荐引擎（LLM 调用 + trace 写入 + 状态管理） |
| `server/routes/recommendationRoutes.js` | Create | 3 个 HTTP 端点 + 鉴权 |
| `server/index.js` | Modify | import + 装配 createRecommendationRoutes |
| `server/scheduler.js` | Modify | 17:45 block 加批量预生成 |
| `index.html` | Modify | 替换 `#meetingAssignmentList` panel HTML |
| `src/app.js` | Modify | 新增 `renderMeetingRecommendations` + bindEvents 接 ✓/🔄 |
| `docs/AI-PM-PROGRESS.md` | Modify | 每 Task 完成后更新 Phase 状态表 |

---

## Conventions

- **每 Task 一次 commit**，commit message 用 `feat(ai-pm):` / `refactor(ai-pm):` 前缀
- **每 Task 完成后必跑** `node --check` 全部改动文件
- **每 Task 完成后必更新** `docs/AI-PM-PROGRESS.md` 的对应行（标 ✅、写 commit SHA、有偏离设计的事在"决策日志"加一行）
- 路径所有 cd 都用绝对路径
- 直接基于 spec §X 的代码块，不重写

---

# Phase 1 — 数据模型 + migrateStore

## Task 1.1: Store schema 扩展

**Files:**
- Modify: `server/store.js`（`migrateStore` 函数内，约 line 197 附近）
- Modify: `server/services/dailyBrief.js`（`normalizeAssignment` 函数内，约 line 243-260）

- [ ] **Step 1: 读现有 migrateStore 找到默认值块**

Run: `grep -n "users: \[\]" server/store.js`
Expected: 一行类似 `197:    users: [],`

读 line 175-200 看 next 对象的当前结构。

- [ ] **Step 2: 在 next 对象里加 2 个字段**

用 Edit tool 在 `users: [],` 那行后插入：

```js
    dailyTaskSuggestions: {},
    aiPromptTraces: [],
```

确保插入位置在 `next = { ... }` 字面量内、`...store` 之前。

- [ ] **Step 3: normalizeAssignment 加 2 个字段**

定位 `server/services/dailyBrief.js` 的 `normalizeAssignment`（line 243）。在 `briefGeneratedBy: ...` 这一行之后、`}, store)` 之前补：

```js
    aiSuggested: Boolean(input.aiSuggested),
    aiSuggestionRef: input.aiSuggestionRef || null,
```

确保最终 normalizeAssignment 的返回对象包含这两个字段。

- [ ] **Step 4: 语法检查**

```bash
node --check server/store.js && node --check server/services/dailyBrief.js
```

Expected: 无输出（通过）

- [ ] **Step 5: 启动 smoke**

```bash
PORT=14317 npm run dev > /tmp/smoke1.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:14317/api/state | head -c 300
kill %1 2>/dev/null
wait 2>/dev/null
```

Expected:
- 输出 JSON 前 300 字符，无 stack trace
- `/tmp/smoke1.log` 无 import 错误

- [ ] **Step 6: 验证迁移生效**

```bash
node -e "
import('./server/store.js').then(async (m) => {
  const s = await m.loadStore();
  console.log('dailyTaskSuggestions:', JSON.stringify(s.dailyTaskSuggestions));
  console.log('aiPromptTraces type:', Array.isArray(s.aiPromptTraces) ? 'array' : typeof s.aiPromptTraces);
  console.log('aiPromptTraces length:', s.aiPromptTraces.length);
});
"
```

Expected: `dailyTaskSuggestions: {}` 和 `aiPromptTraces type: array` 和 `length: 0`

- [ ] **Step 7: 更新 progress doc**

把 `docs/AI-PM-PROGRESS.md` 表格 Phase 1 行的"状态"改为 ✅，"提交 SHA" 列填占位 `<step 8 commit>`。

- [ ] **Step 8: Commit**

```bash
git add server/store.js server/services/dailyBrief.js docs/AI-PM-PROGRESS.md
git commit -m "$(cat <<'EOF'
feat(ai-pm): Phase 1 — store schema for dailyTaskSuggestions + aiPromptTraces

migrateStore now defaults dailyTaskSuggestions={} and aiPromptTraces=[].
normalizeAssignment carries aiSuggested boolean + aiSuggestionRef object.

Old assignments without these fields auto-fill on next normalize.
No data migration required.

Refs: spec §2.1 §2.5 §2.6

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

然后 Edit `AI-PM-PROGRESS.md` 把 Phase 1 行的占位 SHA 换成实际 SHA（用 `git log -1 --format=%h`），再用 `git commit --amend --no-edit` 把更新合到同一 commit。

---

# Phase 2 — 推荐引擎 service

## Task 2.1: 创建 dailyTaskSuggester.js

**Files:**
- Create: `server/services/dailyTaskSuggester.js`

- [ ] **Step 1: 创建文件结构**

新建 `server/services/dailyTaskSuggester.js`，包含以下 imports 和导出。**完整代码：**

```js
import { createHash } from 'node:crypto';
import { callClaude, isAvailable } from './claude.js';
import { loadStore, updateStore } from '../store.js';

// 输出格式：JSON 数组，每项 {taskId, score, reason, hint}
const SYSTEM_PROMPT = `你是研发任务匹配助手。基于成员的最近工作 + 任务的技术栈，从候选池里给出 top 3 推荐。

输入：
- 候选任务列表（id / title / acceptance / sourceDoc / deliverable.title）
- 当前成员 profile（姓名 / 最近 commits / 当前在进行任务 / 历史擅长模块）

输出 JSON 数组：[{ "taskId": "...", "score": 0-100, "reason": "一句话(<40字)", "hint": "实施提示(<60字)" }]
按 score 降序，至多 5 项（前端取 top 3）

规则：
- score ≥ 70 = 强匹配（技术栈匹配 + 上下文延续）
- 50-69 = 中匹配
- < 50 不输出
- reason 必须具体引用 commit 文件或任务关键词，禁止"非常合适"等空话
- 仅返回 JSON 数组，不要 markdown 包裹、不要解释`;

const SYSTEM_PROMPT_HASH = createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 8);

const LLM_TIMEOUT_MS = 12_000;
const TRACE_KEEP = 200;

export class LLMUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LLMUnavailableError';
    this.cause = cause;
  }
}

/**
 * 为单个 user 在 forDate 生成推荐
 * @param {string} forDate YYYY-MM-DD
 * @param {string} userId
 * @param {object} store - 调用方传入的 store snapshot
 * @param {object} options - { triggeredBy: 'scheduler' | 'manual' }
 * @returns {Promise<{candidates, pool}>}
 * @throws LLMUnavailableError 如果 LLM 不可用或失败
 */
export async function generateDailyTaskSuggestions(forDate, userId, store, options = {}) {
  const triggeredBy = options.triggeredBy || 'manual';

  // 1. 召回候选池
  const excludedTaskIds = collectSupersededTaskIds(forDate, userId, store);
  const takenTaskIds = collectAcceptedTaskIds(forDate, store);
  const eligible = (store.tasks || []).filter((t) => (
    t.status === 'pending'
    && (t.owner === '待认领' || !t.owner)
    && !excludedTaskIds.has(t.id)
    && !takenTaskIds.has(t.id)
  ));

  if (!eligible.length) {
    return { candidates: [], pool: { eligibleCount: 0, totalEvaluated: 0 } };
  }

  // 2. 收集 user context
  const userContext = buildUserContext(userId, store);

  // 3. LLM 排序
  if (!isAvailable()) {
    throw new LLMUnavailableError('ANTHROPIC_API_KEY 未配置');
  }

  const userPromptSnapshot = buildUserPrompt(eligible, userContext);
  const startedAt = Date.now();
  let rawOutput = null;
  let parseError = null;
  let parsedCandidates = [];

  try {
    rawOutput = await Promise.race([
      callClaude(SYSTEM_PROMPT, userPromptSnapshot),
      timeoutAfter(LLM_TIMEOUT_MS)
    ]);
    if (!rawOutput) {
      throw new LLMUnavailableError('callClaude 返回 null');
    }
    parsedCandidates = parseRanking(rawOutput, eligible);
    if (!parsedCandidates.length) {
      throw new LLMUnavailableError('LLM 输出无有效推荐');
    }
  } catch (err) {
    parseError = err.message || String(err);
    // 写失败 trace，再抛
    await appendTrace({
      userId, forDate, triggeredBy,
      userPromptSnapshot, rawOutput,
      parsedCandidates: [], parseError,
      durationMs: Date.now() - startedAt
    });
    throw err instanceof LLMUnavailableError ? err : new LLMUnavailableError(parseError, err);
  }

  // 4. 写成功 trace
  const traceId = await appendTrace({
    userId, forDate, triggeredBy,
    userPromptSnapshot, rawOutput,
    parsedCandidates, parseError: null,
    durationMs: Date.now() - startedAt
  });

  // 5. 取 top 3，挂 traceId
  return {
    candidates: parsedCandidates.slice(0, 3).map((r) => ({
      taskId: r.taskId,
      score: r.score,
      reason: r.reason,
      hint: r.hint,
      status: 'pending',
      actedAt: null,
      acceptedAssignmentId: null,
      traceId
    })),
    pool: { eligibleCount: eligible.length, totalEvaluated: parsedCandidates.length }
  };
}

function collectSupersededTaskIds(forDate, userId, store) {
  const set = new Set();
  const dayMap = store.dailyTaskSuggestions?.[forDate];
  const userEntry = dayMap?.[userId];
  if (!userEntry) return set;
  for (const c of userEntry.candidates || []) {
    if (c.status === 'superseded') set.add(c.taskId);
  }
  return set;
}

function collectAcceptedTaskIds(forDate, store) {
  // 接受过的任务（owner 已经不是"待认领"了），用 task.owner 判定 + assignments 反查
  const set = new Set();
  for (const t of store.tasks || []) {
    if (t.owner && t.owner !== '待认领') set.add(t.id);
  }
  return set;
}

function buildUserContext(userId, store) {
  const user = (store.users || []).find((u) => u.id === userId) || {};
  const userName = user.name || user.username || userId;

  // 最近 14 天 commits
  const fortnightAgo = Date.now() - 14 * 24 * 3600 * 1000;
  const recentActivities = (store.activities || []).filter((a) => {
    if (a.actor !== userName && !String(a.actor || '').includes(userName)) return false;
    const ts = new Date(a.createdAt || a.committedAt || 0).getTime();
    return ts >= fortnightAgo;
  }).slice(0, 20);

  const recentCommitMsgs = recentActivities.map((a) => a.title || a.message || '').filter(Boolean).slice(0, 10);
  const recentCommitFiles = Array.from(new Set(
    recentActivities.flatMap((a) => a.files || []).slice(0, 25)
  ));

  // 当前进行中的任务
  const currentTasks = (store.tasks || [])
    .filter((t) => t.owner === userName && t.status !== '已完成' && t.status !== 'done')
    .map((t) => t.title)
    .slice(0, 5);

  return { name: userName, recentCommitMsgs, recentCommitFiles, currentTasks };
}

function buildUserPrompt(eligible, userContext) {
  const tasksBlock = eligible.map((t) => ({
    id: t.id,
    title: t.title,
    acceptance: (t.acceptance || '').slice(0, 120),
    sourceDoc: t.sourceDoc || '',
    deliverableTitle: t.deliverableId ? t.deliverableId : null,
    priority: t.priority || ''
  }));
  return [
    '## 候选任务',
    JSON.stringify(tasksBlock, null, 2),
    '',
    '## 当前成员',
    JSON.stringify(userContext, null, 2),
    '',
    '请按规则输出 JSON 数组。'
  ].join('\n');
}

function parseRanking(raw, eligible) {
  const eligibleIds = new Set(eligible.map((t) => t.id));
  let text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r === 'object' && eligibleIds.has(r.taskId) && Number(r.score) >= 50)
      .map((r) => ({
        taskId: r.taskId,
        score: Math.max(0, Math.min(100, Number(r.score) || 0)),
        reason: String(r.reason || '').slice(0, 80),
        hint: String(r.hint || '').slice(0, 100)
      }))
      .sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

async function appendTrace(payload) {
  const traceId = `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await updateStore((draft) => {
    draft.aiPromptTraces = draft.aiPromptTraces || [];
    draft.aiPromptTraces.unshift({
      traceId,
      feature: 'daily-task-suggestion',
      systemPromptHash: SYSTEM_PROMPT_HASH,
      timestamp: new Date().toISOString(),
      ...payload
    });
    draft.aiPromptTraces = draft.aiPromptTraces.slice(0, TRACE_KEEP);
    return draft;
  });
  return traceId;
}

function timeoutAfter(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new LLMUnavailableError(`LLM 调用超时（${ms}ms）`)), ms)
  );
}
```

- [ ] **Step 2: 语法检查**

```bash
node --check server/services/dailyTaskSuggester.js
```

Expected: 无输出

- [ ] **Step 3: 单元 smoke（无 API key 也要能跑到 LLMUnavailableError 分支）**

```bash
ANTHROPIC_API_KEY= node -e "
import('./server/services/dailyTaskSuggester.js').then(async (m) => {
  const { loadStore } = await import('./server/store.js');
  const s = await loadStore();
  try {
    const r = await m.generateDailyTaskSuggestions('2026-05-19', 'user_admin', s, { triggeredBy: 'test' });
    console.log('result:', JSON.stringify(r));
  } catch (e) {
    console.log('expected error:', e.name, '-', e.message);
  }
});
" 2>&1 | head -20
```

Expected: 输出 `expected error: LLMUnavailableError - ANTHROPIC_API_KEY 未配置` （或如果有 key 则真调用并返回 candidates 或 trace error）

- [ ] **Step 4: 验证 trace 写入**

```bash
node -e "
import('./server/store.js').then(async (m) => {
  const s = await m.loadStore();
  const traces = s.aiPromptTraces || [];
  console.log('traces:', traces.length);
  if (traces.length > 0) console.log('latest:', JSON.stringify(traces[0], null, 2).slice(0, 500));
});
"
```

Expected: 如果 Step 3 触发了 LLMUnavailableError 之前的某个分支（比如有 API key 调用失败），trace 应至少 1 条；如果全程未到 LLM（无 key），则 0 条（因为我们在 isAvailable 检查就抛了）。

- [ ] **Step 5: 更新 progress doc**

把 Phase 2 行状态改 ✅。

- [ ] **Step 6: Commit**

```bash
git add server/services/dailyTaskSuggester.js docs/AI-PM-PROGRESS.md
git commit -m "$(cat <<'EOF'
feat(ai-pm): Phase 2 — dailyTaskSuggester service

generateDailyTaskSuggestions(forDate, userId, store, {triggeredBy}) does:
  1. recall eligible tasks (pending, 待认领, not superseded, not taken)
  2. build user context (recent commits + current tasks)
  3. call Claude with cached system prompt (12s timeout)
  4. parse JSON output, validate against eligible ids, sort by score
  5. write trace (success OR failure) to store.aiPromptTraces (cap 200)
  6. return top 3 candidates with traceId for PMF attribution

LLM failures throw LLMUnavailableError. Caller decides how to surface.
No rule-based fallback (per spec §4.4 — fail loud for PMF data purity).

Refs: spec §4

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

amend SHA into progress doc.

---

# Phase 3 — API endpoints

## Task 3.1: 创建 recommendationRoutes.js

**Files:**
- Create: `server/routes/recommendationRoutes.js`

- [ ] **Step 1: 读现有 route factory pattern**

参考 `server/routes/assignmentRoutes.js` line 1-30 看 createXxxRoutes 的标准结构和 deps 注入模式。

- [ ] **Step 2: 创建 recommendationRoutes.js**

**完整代码：**

```js
import { verifySessionToken } from '../services/auth.js';

export function createRecommendationRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  generateDailyTaskSuggestions,
  LLMUnavailableError,
  normalizeAssignment
}) {

  function getCurrentUser(req, store) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : req.headers['x-cue-session-token'] || '';
    const payload = verifySessionToken(token);
    if (!payload?.sub) return null;
    const user = (store.users || []).find((u) => u.id === payload.sub);
    return user || null;
  }

  return async function recommendationRoutes(req, res, url) {
    // GET /api/recommendations?date=YYYY-MM-DD
    if (req.method === 'GET' && url.pathname === '/api/recommendations') {
      const store = await loadStore();
      const user = getCurrentUser(req, store);
      if (!user) { sendError(res, 401, 'login required'); return true; }

      const date = url.searchParams.get('date') || tomorrowText();
      const entry = store.dailyTaskSuggestions?.[date]?.[user.id];
      if (!entry) {
        sendJson(res, 200, {
          date, candidates: [], message: '今日推荐尚未生成',
          generatedAt: null, generatedBy: null, pool: null
        });
        return true;
      }

      // 把 candidates 里的 taskId 解 hydrate 成完整 task 对象 + acceptedBy
      const candidates = (entry.candidates || []).map((c) => {
        const task = (store.tasks || []).find((t) => t.id === c.taskId);
        const acceptedBy = task && task.owner && task.owner !== '待认领' && task.owner !== user.name
          ? task.owner
          : null;
        return { ...c, task: task || null, acceptedBy };
      });

      sendJson(res, 200, {
        date,
        generatedAt: entry.generatedAt,
        generatedBy: entry.generatedBy,
        candidates,
        pool: entry.pool
      });
      return true;
    }

    // POST /api/recommendations/refresh
    if (req.method === 'POST' && url.pathname === '/api/recommendations/refresh') {
      const store = await loadStore();
      const user = getCurrentUser(req, store);
      if (!user) { sendError(res, 401, 'login required'); return true; }

      const { json } = await readBody(req);
      const date = (json && json.date) || tomorrowText();

      // 老 candidates 标 superseded
      await updateStore((draft) => {
        draft.dailyTaskSuggestions = draft.dailyTaskSuggestions || {};
        draft.dailyTaskSuggestions[date] = draft.dailyTaskSuggestions[date] || {};
        const existing = draft.dailyTaskSuggestions[date][user.id];
        if (existing?.candidates?.length) {
          for (const c of existing.candidates) {
            if (c.status === 'pending') c.status = 'superseded';
          }
        }
        return draft;
      });

      // 重新生成
      const fresh = await loadStore();
      try {
        const result = await generateDailyTaskSuggestions(date, user.id, fresh, { triggeredBy: 'manual' });
        await updateStore((draft) => {
          draft.dailyTaskSuggestions[date][user.id] = {
            generatedAt: new Date().toISOString(),
            generatedBy: 'manual',
            pool: result.pool,
            candidates: result.candidates
          };
          return draft;
        });
        const after = await loadStore();
        const entry = after.dailyTaskSuggestions[date][user.id];
        sendJson(res, 200, { date, ...entry });
      } catch (err) {
        if (err instanceof LLMUnavailableError) {
          sendError(res, 503, 'AI 推荐暂不可用', err.message);
          return true;
        }
        throw err;
      }
      return true;
    }

    // POST /api/recommendations/:taskId/accept
    const acceptMatch = url.pathname.match(/^\/api\/recommendations\/([^/]+)\/accept$/);
    if (req.method === 'POST' && acceptMatch) {
      const taskId = acceptMatch[1];
      const store = await loadStore();
      const user = getCurrentUser(req, store);
      if (!user) { sendError(res, 401, 'login required'); return true; }

      const { json } = await readBody(req);
      const date = (json && json.date) || tomorrowText();

      const task = (store.tasks || []).find((t) => t.id === taskId);
      if (!task) { sendError(res, 404, 'task not found'); return true; }
      if (task.owner && task.owner !== '待认领' && task.owner !== user.name) {
        sendJson(res, 409, { error: 'task already taken', acceptedBy: task.owner });
        return true;
      }

      // 原子更新：task.owner + 创建 assignment + candidate.status=accepted
      let assignment = null;
      let candidateSnapshot = null;
      await updateStore((draft) => {
        const t = (draft.tasks || []).find((x) => x.id === taskId);
        if (!t) return draft;
        t.owner = user.name;
        t.updatedAt = new Date().toISOString();

        assignment = normalizeAssignment({
          taskId: t.id,
          taskTitle: t.title,
          owner: user.name,
          date,
          note: 'AI 推荐接受',
          aiSuggested: true,
          aiSuggestionRef: { date, userId: user.id, taskId: t.id }
        }, draft);
        draft.assignments = [assignment, ...(draft.assignments || [])].slice(0, 500);

        draft.dailyTaskSuggestions = draft.dailyTaskSuggestions || {};
        const dayEntry = draft.dailyTaskSuggestions[date]?.[user.id];
        if (dayEntry) {
          const cand = dayEntry.candidates.find((c) => c.taskId === taskId);
          if (cand) {
            cand.status = 'accepted';
            cand.actedAt = new Date().toISOString();
            cand.acceptedAssignmentId = assignment.id;
            candidateSnapshot = { ...cand };
          }
        }
        return draft;
      });

      sendJson(res, 200, { assignment, candidate: candidateSnapshot });
      return true;
    }

    return false;
  };
}

function tomorrowText() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
```

- [ ] **Step 3: 语法检查**

```bash
node --check server/routes/recommendationRoutes.js
```

- [ ] **Step 4: Commit (intermediate, before wiring)**

```bash
git add server/routes/recommendationRoutes.js
git commit -m "feat(ai-pm): Phase 3 part 1 — recommendationRoutes (not yet wired)

Three endpoints: GET /api/recommendations, POST refresh, POST :id/accept.
Auth: session token sub → users lookup. Returns 401 if not logged in.
Accept is atomic: task.owner + new assignment + candidate.status=accepted.
Refresh marks old pending → superseded then regenerates.
LLMUnavailableError → 503 with diagnostic message.

Refs: spec §3

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

## Task 3.2: Wire 进 index.js + 路由 dispatcher

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: 加 import**

在 `server/index.js` line 93（`createScoringRoutes` import 那行）后面加：

```js
import { createRecommendationRoutes } from './routes/recommendationRoutes.js';
import {
  generateDailyTaskSuggestions,
  LLMUnavailableError
} from './services/dailyTaskSuggester.js';
```

- [ ] **Step 2: 注册路由模块**

定位 `const routeModules = [` 数组，在 `createScoringRoutes({...})` 那块的 **后面**追加：

```js
  createRecommendationRoutes({
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    generateDailyTaskSuggestions,
    LLMUnavailableError,
    normalizeAssignment
  }),
```

确认 `normalizeAssignment` 在 index.js 顶部已 import（应该已有，来自 `./services/dailyBrief.js`）。如果没有，在那个 import 块加上。

- [ ] **Step 3: 语法 + smoke**

```bash
node --check server/index.js
PORT=14317 npm run dev > /tmp/smoke3.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:14317/api/recommendations?date=2026-05-19 | head -c 200
echo
kill %1 2>/dev/null
wait 2>/dev/null
```

Expected: `{"error":"login required",...}` — 401 因为没 token。**不是** `api route not found`。

- [ ] **Step 4: 更新 progress doc + commit**

把 Phase 3 行状态改 ✅。

```bash
git add server/index.js docs/AI-PM-PROGRESS.md
git commit -m "feat(ai-pm): Phase 3 part 2 — wire recommendationRoutes into index.js

Registered after createScoringRoutes. Available endpoints:
  GET  /api/recommendations?date=YYYY-MM-DD
  POST /api/recommendations/refresh
  POST /api/recommendations/:taskId/accept

Refs: spec §3

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

amend SHA into progress doc.

---

# Phase 4 — 调度器接入 17:45

## Task 4.1: scheduler.js 17:45 block 加批量预生成

**Files:**
- Modify: `server/scheduler.js`
- Modify: `server/index.js`（startScheduler deps）

- [ ] **Step 1: 找到 17:45 块的当前结尾**

```bash
grep -n "进度文档已写回\|批量 update-docs" server/scheduler.js | head -5
```

记下行号（应在 ~180-190 行附近，写回 docs 那个 for 循环之后）。

- [ ] **Step 2: 在 sync-docs 之后插入推荐生成 block**

在"晚报生成后，自动把进度写回 GitHub（update-docs）"那个 try-catch **之后**，插入：

```js
      // 17:45 为所有活跃用户预生成明日推荐（独立 LLM 调用，per-user）
      try {
        const recStore = await loadStore();
        // forDate = 明天，因为是为晚会后明天的工作做准备
        const tomorrow = (() => {
          const d = new Date(Date.now() + 24 * 3600 * 1000);
          const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
          }).formatToParts(d);
          const get = (t) => parts.find((p) => p.type === t)?.value;
          return `${get('year')}-${get('month')}-${get('day')}`;
        })();
        const activeUsers = (recStore.users || []).filter(
          (u) => u.active !== false && u.role !== 'admin'
        );
        let ok = 0;
        let failed = 0;
        for (const user of activeUsers) {
          try {
            const result = await generateDailyTaskSuggestions(tomorrow, user.id, recStore, { triggeredBy: 'scheduler' });
            await updateStore((draft) => {
              draft.dailyTaskSuggestions = draft.dailyTaskSuggestions || {};
              draft.dailyTaskSuggestions[tomorrow] = draft.dailyTaskSuggestions[tomorrow] || {};
              draft.dailyTaskSuggestions[tomorrow][user.id] = {
                generatedAt: new Date().toISOString(),
                generatedBy: 'scheduler',
                pool: result.pool,
                candidates: result.candidates
              };
              return draft;
            });
            ok++;
          } catch (err) {
            failed++;
            console.error(`[Scheduler] 推荐生成失败 ${user.username || user.id}:`, err.message);
          }
        }
        console.log(`[Scheduler] 推荐已生成：${ok} 个用户，${failed} 个失败（forDate=${tomorrow}）`);
        if (failed > 0 && isWeComAvailable()) {
          await sendWeComMarkdown([
            `## ⚠️ AI 推荐生成部分失败`,
            ``,
            `成功 ${ok} 人，失败 ${failed} 人（forDate=${tomorrow}）`,
            ``,
            `检查 ANTHROPIC_API_KEY 配置或服务可用性。`
          ].join('\n')).catch((e) => console.error('[Scheduler] 推荐失败告警推送失败:', e.message));
        }
      } catch (err) {
        console.error('[Scheduler] 批量推荐生成失败:', err.message);
      }
```

- [ ] **Step 3: scheduler.js 顶部 deps 解构加 generateDailyTaskSuggestions**

定位 `const { ... } = deps;` 块（约 line 2-20）。加上 `generateDailyTaskSuggestions,`。

- [ ] **Step 4: index.js 传 dep 给 startScheduler**

定位 `startScheduler({...})` 调用，在 deps 对象里加：

```js
  generateDailyTaskSuggestions,
```

- [ ] **Step 5: 语法 + smoke**

```bash
node --check server/scheduler.js && node --check server/index.js
PORT=14317 npm run dev > /tmp/smoke4.log 2>&1 &
sleep 3
grep -E "推荐|Scheduler" /tmp/smoke4.log | head -5
kill %1 2>/dev/null
wait 2>/dev/null
```

Expected: 启动日志有 scheduler 注册，无 import 错误。（不会立刻触发 17:45 因为不是那个时间）

- [ ] **Step 6: 临时触发测试（可选）**

把 `MEETING_HOUR` 临时设到当前小时 + 1，等 1 分钟看日志：

```bash
# 假设现在是 14 点
MEETING_HOUR=16 PORT=14317 npm run dev > /tmp/smoke4b.log 2>&1 &
# 等到 15:45 看 [Scheduler] 推荐已生成 日志
```

或跳过，留给 Phase 6 整体 E2E。

- [ ] **Step 7: 更新 progress doc + commit**

```bash
git add server/scheduler.js server/index.js docs/AI-PM-PROGRESS.md
git commit -m "feat(ai-pm): Phase 4 — scheduler 17:45 batch generates suggestions

After eveningReport + sync-docs + update-docs, loop active non-admin users
and call generateDailyTaskSuggestions for tomorrow. Per-user trace logged.
If any fail and WeCom available, push alert (fail loud, no silent degrade).

Refs: spec §4.5, §4.4

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

amend SHA into progress doc.

---

# Phase 5 — 前端 panel 改造

## Task 5.1: index.html 替换"会后领取" panel

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 找到要替换的 panel**

```bash
grep -n "meetingAssignmentList\|会后领取" index.html | head -5
```

应该看到 line 683-699 那个 panel（`<article class="meeting-panel meeting-panel-main">` 包"会后领取"+ form + #meetingAssignmentList）。

- [ ] **Step 2: 替换为新 panel HTML**

把那一段 `<article>...</article>` 整体替换为：

```html
              <article class="meeting-panel meeting-panel-main">
                <div class="meeting-panel-head">
                  <div>
                    <span>会后领取</span>
                    <strong>🤖 AI 今日推荐</strong>
                  </div>
                  <button type="button" data-action="refresh-recommendations" class="pc-btn-ghost">🔄 刷新推荐</button>
                </div>
                <div class="recommendation-list" id="meetingRecommendationList">
                  <div class="empty-state">推荐加载中…</div>
                </div>
                <div class="recommendation-meta" id="meetingRecommendationMeta"></div>
              </article>
```

- [ ] **Step 3: 加 CSS（可选最小化）**

打开 `src/styles.css`（或检查是否已有 `.recommendation-list` 样式 — 没有则在文件末尾追加）：

```css
.recommendation-list { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.recommendation-card {
  display: flex; justify-content: space-between; align-items: flex-start;
  padding: 10px; background: #fff; border: 1px solid #e5e7eb;
  border-left: 3px solid #10b981; border-radius: 6px;
}
.recommendation-card.is-taken { opacity: 0.65; border-left-color: #d1d5db; background: #f9fafb; }
.recommendation-card-body { flex: 1; min-width: 0; }
.recommendation-title { font-size: 13px; font-weight: 600; }
.recommendation-meta-line { font-size: 11px; color: #6b7280; margin-top: 4px; line-height: 1.4; }
.recommendation-hint { font-size: 11px; color: #9ca3af; margin-top: 2px; }
.recommendation-score-tag { background: #dcfce7; color: #166534; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
.recommendation-taken-tag { background: #e5e7eb; color: #374151; padding: 1px 6px; border-radius: 3px; }
.recommendation-accept-btn {
  font-size: 12px; padding: 4px 12px; background: #10b981; color: white;
  border: none; border-radius: 4px; cursor: pointer; margin-left: 8px;
}
.recommendation-accept-btn:disabled { background: #e5e7eb; color: #9ca3af; cursor: not-allowed; }
.recommendation-meta {
  text-align: center; font-size: 11px; color: #9ca3af;
  padding: 6px; border-top: 1px solid #f3f4f6;
}
.recommendation-error {
  background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 6px;
  font-size: 12px; margin: 8px;
}
```

- [ ] **Step 4: smoke**

```bash
PORT=14317 npm run dev > /tmp/smoke5a.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:14317/ | grep -c "meetingRecommendationList"
kill %1 2>/dev/null
wait 2>/dev/null
```

Expected: `1` (id 存在于 HTML)

- [ ] **Step 5: commit**

```bash
git add index.html src/styles.css
git commit -m "feat(ai-pm): Phase 5 part 1 — meeting tab '会后领取' panel HTML/CSS

Replace manual dropdown form with #meetingRecommendationList container +
refresh button. CSS for card layout with is-taken muted state.

Refs: spec §5.2

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

## Task 5.2: src/app.js 加 renderMeetingRecommendations + bindEvents

**Files:**
- Modify: `src/app.js`

- [ ] **Step 1: 找到现有 meeting 渲染相关代码**

```bash
grep -nE "renderMeeting|meetingDate|reconciliationList|state\.assignments" src/app.js | head -15
```

记下哪里在切换到 meeting view 时会调用渲染函数。

- [ ] **Step 2: 新增 renderMeetingRecommendations 函数**

在 `src/app.js` 适当位置（建议放在已有 `renderMy*` 函数附近，比如 `renderMyEveningCard` 后）加：

```js
async function renderMeetingRecommendations() {
  const listEl = document.querySelector('#meetingRecommendationList');
  const metaEl = document.querySelector('#meetingRecommendationMeta');
  if (!listEl) return;

  const date = getMeetingDate() || tomorrowStr();
  listEl.innerHTML = '<div class="empty-state">加载推荐中…</div>';
  if (metaEl) metaEl.textContent = '';

  let data;
  try {
    data = await api(`/api/recommendations?date=${encodeURIComponent(date)}`);
  } catch (e) {
    listEl.innerHTML = `<div class="recommendation-error">加载推荐失败：${escapeHtml(e.message || String(e))}</div>`;
    return;
  }

  if (!data.candidates?.length) {
    listEl.innerHTML = `<div class="empty-state">${escapeHtml(data.message || '今日尚无 AI 推荐')}</div>`;
    if (metaEl && data.pool) {
      metaEl.textContent = `候选池 ${data.pool.eligibleCount} 个任务`;
    }
    return;
  }

  listEl.innerHTML = data.candidates.map((c) => {
    const task = c.task || { title: c.taskId };
    const taken = !!c.acceptedBy;
    return `
      <div class="recommendation-card${taken ? ' is-taken' : ''}" data-task-id="${escapeHtml(c.taskId)}" data-date="${escapeHtml(date)}">
        <div class="recommendation-card-body">
          <div class="recommendation-title">${taken ? '🔒 ' : ''}${escapeHtml(task.title || c.taskId)}</div>
          <div class="recommendation-meta-line">
            ${taken
              ? `<span class="recommendation-taken-tag">已被 ${escapeHtml(c.acceptedBy)} 领取</span>`
              : `<span class="recommendation-score-tag">${c.score} 分</span> · ${escapeHtml(c.reason || '')}`
            }
          </div>
          ${!taken && c.hint ? `<div class="recommendation-hint">💡 ${escapeHtml(c.hint)}</div>` : ''}
        </div>
        <button class="recommendation-accept-btn" data-action="accept-recommendation" ${taken || c.status === 'accepted' ? 'disabled' : ''}>
          ${c.status === 'accepted' ? '✓ 已领取' : (taken ? '—' : '✓ 我做')}
        </button>
      </div>
    `;
  }).join('');

  if (metaEl) {
    const ts = data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '-';
    metaEl.textContent = `生成于 ${ts} · 候选池 ${data.pool?.eligibleCount ?? 0} 个任务`;
  }
}

function tomorrowStr() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}
```

如果 `escapeHtml` / `api` / `getMeetingDate` 已存在则不要重复定义；如果 `api(path)` 是 GET-only，需要调整为支持 method/body：参考 src/app.js 里现有的 fetch 调用模式。

- [ ] **Step 3: 在 meeting view 切换时调 render**

找到 meeting view 渲染入口（grep "renderMeeting" 或 router/setRoute 调用），在切到 meeting view 后加 `renderMeetingRecommendations();` 调用。

- [ ] **Step 4: bindEvents 加 ✓ 和 🔄 监听**

找到 `bindEvents()` 函数或 document.addEventListener 中心点。加：

```js
document.addEventListener('click', async (event) => {
  // 接受推荐
  const acceptBtn = event.target.closest('[data-action="accept-recommendation"]');
  if (acceptBtn) {
    const card = acceptBtn.closest('.recommendation-card');
    const taskId = card?.dataset.taskId;
    const date = card?.dataset.date;
    if (!taskId || !date) return;
    acceptBtn.disabled = true;
    acceptBtn.textContent = '提交中…';
    try {
      await api(`/api/recommendations/${encodeURIComponent(taskId)}/accept`, {
        method: 'POST',
        body: JSON.stringify({ date })
      });
      await renderMeetingRecommendations();
    } catch (e) {
      acceptBtn.disabled = false;
      acceptBtn.textContent = '✓ 我做';
      alert(`领取失败：${e.message || e}`);
    }
    return;
  }

  // 刷新推荐
  const refreshBtn = event.target.closest('[data-action="refresh-recommendations"]');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    const orig = refreshBtn.textContent;
    refreshBtn.textContent = '生成中…';
    const date = getMeetingDate() || tomorrowStr();
    try {
      await api('/api/recommendations/refresh', { method: 'POST', body: JSON.stringify({ date }) });
      await renderMeetingRecommendations();
    } catch (e) {
      alert(`刷新失败：${e.message || e}`);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = orig;
    }
  }
});
```

如果项目已有事件委托中心，避免重复绑定——把以上分支并入现有 listener。

- [ ] **Step 5: 语法 + smoke**

```bash
node --check src/app.js
PORT=14317 npm run dev > /tmp/smoke5b.log 2>&1 &
sleep 3
# 手动浏览器测试：打开 http://127.0.0.1:14317/，登录，切到晚会 tab，看是否显示推荐 panel
kill %1 2>/dev/null
wait 2>/dev/null
```

- [ ] **Step 6: 更新 progress doc + commit**

```bash
git add src/app.js docs/AI-PM-PROGRESS.md
git commit -m "feat(ai-pm): Phase 5 part 2 — renderMeetingRecommendations + events

Renders #meetingRecommendationList from GET /api/recommendations.
Click ✓ → POST accept → refresh list.
Click 🔄 → POST refresh → refresh list.
Already-taken candidates show 🔒 X 领取 disabled state.
LLM error surfaces as red banner via /api/recommendations/refresh 503.

Refs: spec §5.3

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

amend SHA into progress doc.

---

# Phase 6 — E2E smoke 验证

## Task 6.1: 全链路烟雾测试 + 补漏修 bug

**Files:**
- (No new files; fix anything that smoke test exposes)

- [ ] **Step 1: 启动服务**

```bash
PORT=14317 npm run dev > /tmp/e2e.log 2>&1 &
sleep 4
```

- [ ] **Step 2: 获取一个 session token（用现有 admin 或 seed user）**

```bash
# 检查现有 login flow，可能用 POST /api/auth/login 或类似端点
grep -nE "POST /api/auth|signSessionToken|createSessionToken" server/routes/*.js | head -5
```

按现有 login 流程拿到 token。

- [ ] **Step 3: 触发 refresh 强制生成**

```bash
TOKEN="<你的 token>"
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-05-19"}' \
  http://127.0.0.1:14317/api/recommendations/refresh | jq
```

Expected (有 API key)：返回 `{ "date": "2026-05-19", "candidates": [...], "pool": {...} }` 或者（如果池子为空）candidates 为空。
Expected (无 API key)：返回 503 + `"AI 推荐暂不可用"`

- [ ] **Step 4: GET 验证落库**

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:14317/api/recommendations?date=2026-05-19" | jq
```

应该跟 Step 3 返回的 candidates 一致。

- [ ] **Step 5: Accept 一个推荐**

```bash
# 从 Step 3 的 candidates 取一个 taskId
TASK_ID="<task_xxx>"
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-05-19"}' \
  "http://127.0.0.1:14317/api/recommendations/$TASK_ID/accept" | jq
```

Expected: `{ "assignment": {...}, "candidate": {...} }` — assignment.aiSuggested === true。

- [ ] **Step 6: 验证 task.owner 已更新**

```bash
curl -s "http://127.0.0.1:14317/api/state" | jq ".tasks[] | select(.id==\"$TASK_ID\") | .owner"
```

Expected: 当前用户的中文名（不是 "待认领"）

- [ ] **Step 7: 验证 trace 写入**

```bash
curl -s "http://127.0.0.1:14317/api/state" | jq '.aiPromptTraces | length, .aiPromptTraces[0] // null | {traceId, feature, userId, forDate, durationMs, parseError}'
```

Expected: length ≥ 1, 最新一条 feature === "daily-task-suggestion"。

- [ ] **Step 8: 冲突测试**

```bash
# 拿另一个用户的 token，再 accept 同一个 task
TOKEN2="<另一用户 token>"
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN2" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-05-19"}' \
  "http://127.0.0.1:14317/api/recommendations/$TASK_ID/accept" | jq
```

Expected: HTTP 409 + `{ "error": "task already taken", "acceptedBy": "<前一用户名>" }`

- [ ] **Step 9: 浏览器端 manual smoke**

打开 `http://127.0.0.1:14317/`，登录，切到"晚会"tab：
- [ ] 看到"AI 今日推荐"标题 + 刷新按钮
- [ ] 看到 candidates 列表（如果 Step 3 生成过的话）
- [ ] 点 ✓ → 卡片变 ✓ 已领取
- [ ] 点 🔄 → spinner → 新 candidates
- [ ] 在另一浏览器/隐身窗口用别人账号登入 → 同一任务显示 🔒 已被 X 领取

- [ ] **Step 10: kill server**

```bash
kill %1 2>/dev/null
wait 2>/dev/null
```

- [ ] **Step 11: 把 E2E 发现的所有 bug 修掉**

每个 bug 单独 commit，message 形如 `fix(ai-pm): <具体问题>`。

- [ ] **Step 12: 最终 progress doc 更新**

把 Phase 6 状态改 ✅，"当前状态" 改成 🟢 已上线（thin slice 完成），日期更新到今天。

```bash
git add docs/AI-PM-PROGRESS.md
git commit -m "docs(ai-pm): mark Sprint 1.5a thin slice complete

All 6 Phases done. E2E smoke passed:
  ✅ GET / POST refresh / POST accept all return expected shape
  ✅ task.owner updates atomically with assignment creation
  ✅ aiPromptTraces logged
  ✅ 409 conflict on double-accept
  ✅ browser manual smoke (login → meeting tab → ✓ → 🔄)

Ready for team to start using. PMF data collection begins now.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Self-Review

### 1. Spec coverage

| Spec § | 实现于 |
|---|---|
| §2.1 dailyTaskSuggestions | Task 1.1 |
| §2.2 status 语义 | Task 2.1 (suggester) + Task 3.1 (accept handler) |
| §2.3 跨表关联 | Task 1.1 (normalizeAssignment) + Task 3.1 (accept) |
| §2.4 supersede 排除 | Task 2.1 (collectSupersededTaskIds) |
| §2.5 aiPromptTraces | Task 1.1 (default) + Task 2.1 (appendTrace) |
| §2.6 migrateStore | Task 1.1 |
| §3.0 鉴权 | Task 3.1 (getCurrentUser) |
| §3.1 GET | Task 3.1 |
| §3.2 refresh | Task 3.1 |
| §3.3 accept | Task 3.1 |
| §3.4 内部 generateDailyTaskSuggestions | Task 2.1 |
| §4.2 召回 | Task 2.1 |
| §4.3 LLM 排序 | Task 2.1 |
| §4.4 fail loud | Task 2.1 (LLMUnavailableError) + Task 3.1 (503) + Task 4.1 (WeCom alert) |
| §4.5 trace | Task 2.1 |
| §4.6 forDate | Task 2.1 + Task 4.1 (tomorrow) + Task 3.1 (tomorrowText helper) |
| §5.1-§5.3 UI | Task 5.1 + Task 5.2 |
| §6 验证 | Task 6.1 |

All covered.

### 2. Placeholder scan

- 无 "TBD" / "TODO"
- 所有代码块完整
- 验证命令具体可执行
- "<step N commit>" 等占位有明确指示在后续 step 用 `git log -1 --format=%h` 替换

### 3. Type consistency

- `generateDailyTaskSuggestions(forDate, userId, store, options)` 一致出现于 Task 2.1, 3.1, 4.1
- `LLMUnavailableError` 一致 import/export
- `normalizeAssignment(input, store)` 二参一致（来自现有代码）
- `dailyTaskSuggestions[forDate][userId]` 结构在 Task 2.1, 3.1, 4.1 一致
- `assignment.aiSuggested` + `assignment.aiSuggestionRef` 在 Task 1.1 (normalize) + Task 3.1 (set) 一致
- candidate.status: 'pending' | 'accepted' | 'superseded' 三态一致
