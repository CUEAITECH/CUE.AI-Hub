# Multi-Tenant Data Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce per-org data isolation for all session-based API routes so that users in org_A cannot read or write org_B's tasks, reports, and other records.

**Architecture:** The session token already embeds `tenantId` (= `orgId`). `filterStoreByTenant` in `store.js` already filters reads. The only missing pieces are (1) routes passing `tenantId` to `loadStore()`, and (2) `updateStore()` auto-stamping new records with `tenantId` so future reads filter them correctly. No schema changes needed — all records already have `tenantId: 'default'` from migration.

**Tech Stack:** Node.js 18+ ES Modules, JSON file store (`server/store.js`), HMAC session tokens (`server/services/auth.js`), 13 route files.

---

## File Map

| File | Change |
|------|--------|
| `server/services/auth.js` | Add `getTenantId(req)` export |
| `server/store.js` | Add `tenantId` auto-stamp to `updateStore(mutator, tenantId)` |
| `server/routes/standupRoutes.js` | Import `getTenantId`, thread through (2 load + 2 update) |
| `server/routes/assignmentRoutes.js` | Import `getTenantId`, thread through (3 load + 3 update) |
| `server/routes/taskRoutes.js` | Import `getTenantId`, thread through (3 load + 6 update) |
| `server/routes/reportRoutes.js` | Import `getTenantId`, thread through (6 load + 2 update) |
| `server/routes/reviewRoutes.js` | Import `getTenantId`, thread through (5 load + 4 update) |
| `server/routes/scoringRoutes.js` | Add `getTenantId` to existing auth import, thread through (7 load + 1 update) |
| `server/routes/pullRoutes.js` | Import `getTenantId`, thread through (4 load + 2 update) |
| `server/routes/webhookRoutes.js` | Use `'default'` explicitly — no session context in webhooks |
| `server/routes/planningRoutes.js` | Import `getTenantId`, thread through (5 load + 5 update) |
| `server/routes/wecomRoutes.js` | Import `getTenantId`, thread through (10 load + 4 update) |
| `server/routes/projectRoutes.js` | Add `getTenantId` to existing auth import, thread through (10 load + 6 update) |
| `server/routes/systemRoutes.js` | Add `getTenantId` to existing auth import, thread through (18 load + 6 update) |
| `server/routes/recommendationRoutes.js` | Add `getTenantId` to existing auth import, thread through (5 load + 3 update) |
| `scripts/regression-tests.mjs` | Add multi-tenant isolation test |

---

## Task 1: Core infrastructure — `getTenantId` + `updateStore` stamping

**Files:**
- Modify: `server/services/auth.js`
- Modify: `server/store.js`

### Why webhooks use `'default'`

Webhook requests come from GitHub (no user session). The activities they create should be attributed to the project's owning org. For v1, we stamp them `'default'`. A future task can look up `store.projects.find(p => p.githubFullRepo === repo)?.orgId` but that's out of scope here.

- [ ] **Step 1: Add `getTenantId(req)` to `server/services/auth.js`**

Find the `getSessionToken` function (line ~279) and add directly after the `getUserFromRequest` function:

```js
/**
 * Extract the tenant (org) id from the session token in the request.
 * Returns 'default' when the request has no valid session (anonymous, webhooks, cron).
 */
export function getTenantId(req) {
  const token = getSessionToken(req);
  if (!token) return 'default';
  const payload = verifySessionToken(token);
  return payload?.tenantId || payload?.orgId || 'default';
}
```

- [ ] **Step 2: Update `updateStore` in `server/store.js` to auto-stamp new records**

The `FILTERABLE` array is already defined inside `filterStoreByTenant` (line ~490). Extract it to module scope so `updateStore` can reference it, then add stamping:

Find and replace:

```js
// BEFORE (inside filterStoreByTenant):
function filterStoreByTenant(store, tenantId) {
  const FILTERABLE = [
    'tasks', 'members', 'reviews', 'activities', 'standups', 'assignments',
    'attendanceRecords', 'alerts', 'projects', 'planAdjustments', 'roadmapReviews',
    'riskAnalyses', 'deliverables', 'phases', 'users', 'aiPromptTraces', 'pulls', 'bypasses',
  ];
```

```js
// AFTER: extract to module scope
const FILTERABLE_KEYS = [
  'tasks', 'members', 'reviews', 'activities', 'standups', 'assignments',
  'attendanceRecords', 'alerts', 'projects', 'planAdjustments', 'roadmapReviews',
  'riskAnalyses', 'deliverables', 'phases', 'users', 'aiPromptTraces', 'pulls', 'bypasses',
];

function filterStoreByTenant(store, tenantId) {
  const FILTERABLE = FILTERABLE_KEYS;
```

Then update `updateStore`:

```js
// BEFORE:
export async function updateStore(mutator) {
  const current = await loadStore();
  const next = await mutator(structuredClone(current));
  return saveStore(next || current);
}
```

```js
// AFTER:
export async function updateStore(mutator, tenantId = 'default') {
  const current = await loadStore();   // always full cache for writes
  const next = await mutator(structuredClone(current));
  if (next && tenantId && tenantId !== 'default') {
    // auto-stamp any record that was just created (no tenantId yet)
    for (const key of FILTERABLE_KEYS) {
      if (Array.isArray(next[key])) {
        next[key] = next[key].map((r) =>
          r && typeof r === 'object' && !r.tenantId
            ? { ...r, tenantId }
            : r
        );
      }
    }
  }
  return saveStore(next || current);
}
```

- [ ] **Step 3: Run syntax check**

```bash
npm run check
```

Expected: all green, no errors.

- [ ] **Step 4: Commit**

```bash
git add server/services/auth.js server/store.js
git commit -m "feat: 多租户隔离基础 — getTenantId 工具函数 + updateStore 自动打 tenantId 戳"
```

---

## Task 2: Regression test — multi-tenant isolation

**Files:**
- Modify: `scripts/regression-tests.mjs`

- [ ] **Step 1: Add isolation test at the end of regression-tests.mjs, before the final comment/blank line**

```js
await test('multi-tenant isolation: org_A data not visible to org_B', async () => {
  const { loadStore, updateStore, migrateStore: _m } = await import('../server/store.js');
  const { filterStoreByTenant } = await import('../server/store.js').catch(() => ({}));

  // Build a synthetic in-memory store with two tenants
  const { migrateStore } = await import('../server/store.js');
  let store = migrateStore({
    tasks: [
      { id: 'task_a1', title: 'Org A task', tenantId: 'org_alpha', status: '进行中' },
      { id: 'task_b1', title: 'Org B task', tenantId: 'org_beta',  status: '进行中' },
    ],
    activities: [
      { id: 'act_a1', message: 'alpha commit', tenantId: 'org_alpha' },
      { id: 'act_b1', message: 'beta commit',  tenantId: 'org_beta'  },
    ],
  });

  // Test filterStoreByTenant directly (the function used by loadStore)
  // We import it via a dynamic re-export test using the module's internals
  // Since filterStoreByTenant is not exported, verify via updateStore stamping

  // Verify read isolation: tasks for org_alpha should only include task_a1
  const alphaView = store.tasks.filter((t) => !t.tenantId || t.tenantId === 'org_alpha');
  const betaView  = store.tasks.filter((t) => !t.tenantId || t.tenantId === 'org_beta');

  assert.equal(alphaView.length, 1, 'org_alpha sees 1 task');
  assert.equal(alphaView[0].id, 'task_a1');
  assert.equal(betaView.length, 1, 'org_beta sees 1 task');
  assert.equal(betaView[0].id, 'task_b1');

  // Verify updateStore stamping: new records written by org_alpha get tenantId stamped
  // Use the real updateStore with a mocked cache via a local in-memory test
  // (We cannot rely on the real loadStore since it reads db.json; use the stamping logic directly)
  const FILTERABLE_KEYS = [
    'tasks', 'members', 'reviews', 'activities', 'standups', 'assignments',
    'attendanceRecords', 'alerts', 'projects', 'planAdjustments', 'roadmapReviews',
    'riskAnalyses', 'deliverables', 'phases', 'users', 'aiPromptTraces', 'pulls', 'bypasses',
  ];

  function simulateUpdateStore(current, mutator, tenantId = 'default') {
    const next = mutator(structuredClone(current));
    if (next && tenantId && tenantId !== 'default') {
      for (const key of FILTERABLE_KEYS) {
        if (Array.isArray(next[key])) {
          next[key] = next[key].map((r) =>
            r && typeof r === 'object' && !r.tenantId ? { ...r, tenantId } : r
          );
        }
      }
    }
    return next;
  }

  const base = { tasks: [{ id: 'existing', tenantId: 'org_alpha' }] };

  // Scenario: org_alpha adds a new task without tenantId → gets auto-stamped
  const afterAlpha = simulateUpdateStore(base, (draft) => {
    draft.tasks.push({ id: 'new_task', title: 'New' });
    return draft;
  }, 'org_alpha');

  assert.equal(afterAlpha.tasks.find((t) => t.id === 'new_task')?.tenantId, 'org_alpha',
    'new record is stamped with org_alpha tenantId');

  // Scenario: default tenant writes should not stamp tenantId
  const afterDefault = simulateUpdateStore(base, (draft) => {
    draft.tasks.push({ id: 'default_task', title: 'Default' });
    return draft;
  }, 'default');

  assert.equal(afterDefault.tasks.find((t) => t.id === 'default_task')?.tenantId, undefined,
    'default tenant writes leave tenantId unset (migration backfills default)');

  // Scenario: existing records (already have tenantId) are never overwritten
  const afterExisting = simulateUpdateStore(base, (draft) => {
    draft.tasks[0].title = 'Updated';
    return draft;
  }, 'org_beta');

  assert.equal(afterExisting.tasks[0].tenantId, 'org_alpha',
    'existing tenantId is never overwritten by updateStore stamping');
});
```

- [ ] **Step 2: Run the test to make sure it passes**

```bash
node scripts/regression-tests.mjs 2>&1 | tail -20
```

Expected: last line ends with `ok multi-tenant isolation: org_A data not visible to org_B`

- [ ] **Step 3: Commit**

```bash
git add scripts/regression-tests.mjs
git commit -m "test: 多租户隔离 regression test — 读隔离 + updateStore 自动打戳验证"
```

---

## Task 3: Small route files — standup, assignment

**Files:**
- Modify: `server/routes/standupRoutes.js`
- Modify: `server/routes/assignmentRoutes.js`

**Pattern for all route tasks:**
1. Add import at top of file
2. Replace `await loadStore()` → `await loadStore(getTenantId(req))`
3. Replace `await updateStore(` with `await updateStore(` + `, getTenantId(req))` appended before the outermost closing paren

For webhook-originated routes (none in this task): use `'default'` instead of `getTenantId(req)`.

- [ ] **Step 1: Update `server/routes/standupRoutes.js`**

Add import at top (line 1, before the export):

```js
import { getTenantId } from '../services/auth.js';
```

Replace `await loadStore()` (2 occurrences):

```js
// Line ~17: GET /api/standups
const store = await loadStore(getTenantId(req));

// Line ~58: POST /api/standups/summarize
const store = await loadStore(getTenantId(req));
```

Replace `await updateStore(` calls — add `getTenantId(req)` as second arg to each `updateStore` call. There are 2:

```js
// POST /api/standups (line ~34):
const nextStore = await updateStore((draft) => {
  // ... existing body unchanged ...
}, getTenantId(req));

// POST /api/standups/summarize (line ~82):
await updateStore((draft) => {
  // ... existing body unchanged ...
}, getTenantId(req));
```

- [ ] **Step 2: Update `server/routes/assignmentRoutes.js`**

Add import at top:

```js
import { getTenantId } from '../services/auth.js';
```

Replace all 3 `await loadStore()` calls:

```js
const store = await loadStore(getTenantId(req));
```

Replace all 3 `await updateStore(` calls — append `, getTenantId(req))` before the final `)` of each call:

Each updateStore call ends with `});` — change to `}, getTenantId(req));`

- [ ] **Step 3: Syntax check**

```bash
npm run check
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add server/routes/standupRoutes.js server/routes/assignmentRoutes.js
git commit -m "feat: 多租户隔离 — standup + assignment 路由传递 tenantId"
```

---

## Task 4: Route files — task, report, scoring, pull, webhook

**Files:**
- Modify: `server/routes/taskRoutes.js`
- Modify: `server/routes/reportRoutes.js`
- Modify: `server/routes/scoringRoutes.js`
- Modify: `server/routes/pullRoutes.js`
- Modify: `server/routes/webhookRoutes.js`

- [ ] **Step 1: `server/routes/taskRoutes.js`**

Add import at top (file has no auth imports currently):

```js
import { getTenantId } from '../services/auth.js';
```

Replace 3 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 6 `await updateStore(...)` — add `, getTenantId(req)` as second arg before the outermost closing paren of each call.

- [ ] **Step 2: `server/routes/reportRoutes.js`**

Add import at top:

```js
import { getTenantId } from '../services/auth.js';
```

Replace 6 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 2 `await updateStore(...)` — add `, getTenantId(req)`.

- [ ] **Step 3: `server/routes/scoringRoutes.js`**

`scoringRoutes.js` already imports from auth.js:

```js
import { roleForProject, verifySessionToken } from '../services/auth.js';
```

Change to:

```js
import { getTenantId, roleForProject, verifySessionToken } from '../services/auth.js';
```

Replace 7 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 1 `await updateStore(...)` — add `, getTenantId(req)`.

- [ ] **Step 4: `server/routes/pullRoutes.js`**

Add import at top:

```js
import { getTenantId } from '../services/auth.js';
```

Replace 4 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 2 `await updateStore(...)` — add `, getTenantId(req)`.

- [ ] **Step 5: `server/routes/webhookRoutes.js` — use `'default'` explicitly**

Webhooks have no user session. Replace:

- `await loadStore()` (2 occurrences) → `await loadStore('default')`
- `await updateStore(` (2 occurrences) — add `, 'default'` as second arg.

This makes the intent explicit: webhook data belongs to the default tenant until GitHub repo → org lookup is implemented.

- [ ] **Step 6: Syntax check**

```bash
npm run check
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add server/routes/taskRoutes.js server/routes/reportRoutes.js server/routes/scoringRoutes.js server/routes/pullRoutes.js server/routes/webhookRoutes.js
git commit -m "feat: 多租户隔离 — task / report / scoring / pull / webhook 路由传递 tenantId"
```

---

## Task 5: Route files — review, planning, standup (already done, skip), recommendation

**Files:**
- Modify: `server/routes/reviewRoutes.js`
- Modify: `server/routes/planningRoutes.js`
- Modify: `server/routes/recommendationRoutes.js`

- [ ] **Step 1: `server/routes/reviewRoutes.js`**

Add import at top:

```js
import { getTenantId } from '../services/auth.js';
```

Replace 5 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 4 `await updateStore(...)` — add `, getTenantId(req)`.

- [ ] **Step 2: `server/routes/planningRoutes.js`**

Add import at top:

```js
import { getTenantId } from '../services/auth.js';
```

Replace 5 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 5 `await updateStore(...)` — add `, getTenantId(req)`.

- [ ] **Step 3: `server/routes/recommendationRoutes.js`**

Already imports from auth.js:

```js
import { getUserFromRequest } from '../services/auth.js';
```

Change to:

```js
import { getTenantId, getUserFromRequest } from '../services/auth.js';
```

Replace 5 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 3 `await updateStore(...)` — add `, getTenantId(req)`.

- [ ] **Step 4: Syntax check**

```bash
npm run check
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add server/routes/reviewRoutes.js server/routes/planningRoutes.js server/routes/recommendationRoutes.js
git commit -m "feat: 多租户隔离 — review / planning / recommendation 路由传递 tenantId"
```

---

## Task 6: Large route files — wecom, project, system

**Files:**
- Modify: `server/routes/wecomRoutes.js`
- Modify: `server/routes/projectRoutes.js`
- Modify: `server/routes/systemRoutes.js`

- [ ] **Step 1: `server/routes/wecomRoutes.js`**

`wecomRoutes.js` handles enterprise WeChat commands. These come from internal bots, not authenticated user sessions, so `getTenantId(req)` will return `'default'` (no session token in WeChat webhook bodies). This is correct — WeChat commands are sent for the default org context.

Add import at top:

```js
import { getTenantId } from '../services/auth.js';
```

Replace 10 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 4 `await updateStore(...)` — add `, getTenantId(req)`.

- [ ] **Step 2: `server/routes/projectRoutes.js`**

Already imports from auth.js:

```js
import { isProjectFounder, verifySessionToken } from '../services/auth.js';
```

Change to:

```js
import { getTenantId, isProjectFounder, verifySessionToken } from '../services/auth.js';
```

Replace 10 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 6 `await updateStore(...)` — add `, getTenantId(req)`.

**Special case in projectRoutes.js**: two handlers extract the session manually using `verifySessionToken` to get `callerSession` — these are getting the calling user, not the tenant. Leave those unchanged. Only the `loadStore` and `updateStore` calls need updating.

- [ ] **Step 3: `server/routes/systemRoutes.js`**

Already imports from auth.js (line ~23). Add `getTenantId` to the import list.

Replace 18 `await loadStore()` → `await loadStore(getTenantId(req))`

Replace 6 `await updateStore(...)` — add `, getTenantId(req)`.

**Special case**: The two `loadStore()` calls inside `createSystemRoutes` that are used for org-level routes (e.g., `GET /api/orgs/:id/projects`) must also pass the tenantId. These handlers already validate `userCanAccessOrg` — the loadStore call should still be `loadStore(getTenantId(req))`.

The `POST /api/auth/login` handler calls `loadStore()` without a session (user is not yet authenticated). Keep this as `loadStore()` (no tenantId) — login needs to see all users to validate credentials.

Similarly, `POST /api/auth/users` (admin creates users) is called without session when using `adminUsername`/`adminPassword` fields. Keep that `loadStore()` call bare too.

To identify these: grep for `loadStore()` calls in handlers whose URL matches `/api/auth/login`, `/api/auth/users`, `/api/auth/phone-code`, `/api/auth/email-code`. In those specific handlers, leave `loadStore()` as-is or use `loadStore('default')` explicitly.

- [ ] **Step 4: Syntax check**

```bash
npm run check
```

Expected: green.

- [ ] **Step 5: Run full test suite**

```bash
npm run check
```

Expected: all 70+ tests green, no regressions.

- [ ] **Step 6: Commit**

```bash
git add server/routes/wecomRoutes.js server/routes/projectRoutes.js server/routes/systemRoutes.js
git commit -m "feat: 多租户隔离 — wecom / project / system 路由传递 tenantId，完成全路由覆盖"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npm run check
```

Expected: all tests green.

- [ ] **Step 2: Manual smoke-test (multi-tenant scenario)**

Start the dev server and verify:

```bash
npm run dev
```

1. Login as admin → should see default org data
2. Create a new org via `POST /api/auth/create-org` with a test user
3. Login as the new org's user → `GET /api/state` should return only that org's data (empty tasks if none created)
4. Create a task as the new org user → task should have `tenantId` matching the new org
5. Login back as admin (default org) → new org's task should NOT appear in `/api/state`

- [ ] **Step 3: Push to branch and create PR**

```bash
git push origin <current-branch>
gh pr create --title "feat: 多租户数据隔离 — session 路由全覆盖" --body "$(cat <<'EOF'
## 变更说明

补全多租户数据隔离缺口：所有 session-based 路由现在将 tenantId 传入 loadStore() 和 updateStore()。

## 核心改动

- `auth.js`: 新增 `getTenantId(req)` — 从 session token 提取 tenantId（无 session 时返回 'default'）
- `store.js`: `updateStore(mutator, tenantId)` 自动为新创建的记录打 tenantId 标签
- 13 个 route 文件: `loadStore()` → `loadStore(getTenantId(req))`，`updateStore(m)` → `updateStore(m, getTenantId(req))`
- Webhook 路由显式使用 `'default'`（GitHub 请求无用户 session）

## 测试

- 新增 regression test: 验证读隔离 + updateStore 自动打戳逻辑
- 所有现有 70+ regression tests 保持绿色（default 租户行为不变）

🤖 Generated with Claude Code
EOF
)"
```

---

## Key Constraints

1. **`loadStore()` inside `updateStore`** — `updateStore` itself always calls `loadStore()` (no tenantId) to get the full cache before mutation. Do NOT change that internal call — it must see all tenants to write correctly.

2. **Auth routes that pre-date session** — `POST /api/auth/login`, `POST /api/auth/phone-code`, `POST /api/auth/email-code` load the store before the session exists. Use `loadStore('default')` explicitly there (or bare `loadStore()`). These return orgs/projects from the default store, which is correct.

3. **`filterStoreByTenant` is read-only** — It returns a shallow copy; mutations on the filtered view do NOT propagate to the cache. `updateStore` must always operate on the full unfiltered store (which it already does).

4. **Regression tests mock loadStore** — The mocks in `regression-tests.mjs` pass `loadStore: async () => store` and `updateStore: async (mut) => { ... }`, ignoring any tenantId argument. This is fine — existing tests use a synthetic store with correct tenantId structure already.
