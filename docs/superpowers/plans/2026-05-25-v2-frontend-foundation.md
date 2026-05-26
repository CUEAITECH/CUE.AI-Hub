# V2 Frontend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a tested v2 frontend foundation so the main app can migrate away from v1-shaped global fetch/render code without changing the visual UI in this sprint.

**Architecture:** Introduce `src/api/*` domain clients around a shared `httpClient`, `src/state/*` plain JavaScript stores/selectors, and script-based node/integration tests. Existing `src/app.js` will start using the domain APIs for login, project loading, app state, PR actions, and observability while keeping render functions mostly in place.

**Tech Stack:** Plain browser JavaScript ESM, Node.js ESM assertion tests, existing `npm run check` script, existing `/v2/app/*` facade and native `/v2/*` routes.

---

## File Structure

- Create `src/api/httpClient.js`: shared request mapping, headers, session token, error handling, and injectable fetch/session adapters.
- Create `src/api/authApi.js`: auth/login/email-code/me wrappers.
- Create `src/api/projectsApi.js`: project list and project admin wrappers.
- Create `src/api/appStateApi.js`: state/config/checklist/scoring bundle wrappers.
- Create `src/api/tasksApi.js`: task CRUD, assignment brief, recommendation wrappers.
- Create `src/api/pullsApi.js`: PR list and decision wrappers.
- Create `src/api/eventsApi.js`: grouped events and PR SSE URL helpers.
- Create `src/api/observabilityApi.js`: LLM/events/sync-health wrappers.
- Create `src/state/sessionStore.js`: session token/user state helpers.
- Create `src/state/projectStore.js`: current project selection helpers.
- Create `src/state/taskStore.js`: task merge/update selectors.
- Create `src/state/pullStore.js`: pull merge and review-event helpers.
- Create `src/state/eventStore.js`: grouped event normalization.
- Create `src/state/observabilityStore.js`: observability state updates.
- Create `src/state/selectors.js`: shared selectors.
- Create `src/features/{command-center,work-graph,pr-pipeline,observability}/README.md`: feature boundary docs.
- Create `scripts/test-frontend-api-client.mjs`: node-level API client tests.
- Create `scripts/test-frontend-stores.mjs`: node-level store tests.
- Create `scripts/test-frontend-app-flow.mjs`: integration-style domain API flow test with fake fetch.
- Create `scripts/test-frontend-contracts.mjs`: static raw-fetch guard.
- Modify `src/app.js`: import domain APIs, replace selected fetch call sites while preserving UI behavior.
- Modify `package.json`: add new tests to `npm run check`.

## Task 1: API Client Foundation

**Files:**
- Create: `src/api/httpClient.js`
- Create: `scripts/test-frontend-api-client.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing API client test**

```js
import assert from 'node:assert/strict';
import {
  createHttpClient,
  toV2RequestPath,
} from '../src/api/httpClient.js';

assert.equal(toV2RequestPath('/api/auth/login'), '/v2/app/auth/login');
assert.equal(toV2RequestPath('/v2/observability/llm'), '/v2/observability/llm');

const calls = [];
const client = createHttpClient({
  fetchImpl: async (path, options) => {
    calls.push({ path, options });
    return { ok: true, json: async () => ({ ok: true }) };
  },
  getSessionToken: () => 'session_123',
});

await client.request('/api/auth/me');
assert.equal(calls[0].path, '/v2/app/auth/me');
assert.equal(calls[0].options.headers['X-CUE-Session-Token'], 'session_123');

const failing = createHttpClient({
  fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom', details: 'detail' }) }),
});
await assert.rejects(() => failing.request('/api/state'), /boom：detail/);

console.log('frontend API client tests OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-frontend-api-client.mjs`
Expected: FAIL with module not found for `src/api/httpClient.js`.

- [ ] **Step 3: Implement minimal `httpClient`**

Implement `toV2RequestPath`, `createHttpClient`, and default `httpClient`.

- [ ] **Step 4: Run focused test**

Run: `node scripts/test-frontend-api-client.mjs`
Expected: PASS.

## Task 2: Domain API Modules

**Files:**
- Create: `src/api/authApi.js`
- Create: `src/api/projectsApi.js`
- Create: `src/api/appStateApi.js`
- Create: `src/api/tasksApi.js`
- Create: `src/api/pullsApi.js`
- Create: `src/api/eventsApi.js`
- Create: `src/api/observabilityApi.js`
- Modify: `scripts/test-frontend-api-client.mjs`

- [ ] **Step 1: Extend API client test for domain paths**

Add assertions that `authApi.loginPassword`, `projectsApi.listProjects`, `appStateApi.loadProjectState`, `pullsApi.listPulls`, and `observabilityApi.getLlmStats` call the expected paths through an injected client.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-frontend-api-client.mjs`
Expected: FAIL with missing domain modules.

- [ ] **Step 3: Implement domain API wrappers**

Each module exports `createXApi(client)` and a default API using `httpClient`.

- [ ] **Step 4: Run focused test**

Run: `node scripts/test-frontend-api-client.mjs`
Expected: PASS.

## Task 3: Store Foundation

**Files:**
- Create: `src/state/sessionStore.js`
- Create: `src/state/projectStore.js`
- Create: `src/state/taskStore.js`
- Create: `src/state/pullStore.js`
- Create: `src/state/eventStore.js`
- Create: `src/state/observabilityStore.js`
- Create: `src/state/selectors.js`
- Create: `scripts/test-frontend-stores.mjs`

- [ ] **Step 1: Write failing store tests**

Test session login, project default selection, task merge by id, pull review-event merge, grouped event normalization, and observability update.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-frontend-stores.mjs`
Expected: FAIL with missing store modules.

- [ ] **Step 3: Implement pure store helpers**

Use plain functions. Do not introduce framework state libraries.

- [ ] **Step 4: Run focused test**

Run: `node scripts/test-frontend-stores.mjs`
Expected: PASS.

## Task 4: Integration Flow Test

**Files:**
- Create: `scripts/test-frontend-app-flow.mjs`

- [ ] **Step 1: Write failing integration test**

Use fake fetch to verify password login calls `/v2/app/auth/login`, stores session user/token, then loads `/v2/app/state?projectId=p1`. Verify observability uses native `/v2/observability/llm`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-frontend-app-flow.mjs`
Expected: FAIL until API/store modules are wired.

- [ ] **Step 3: Implement any missing domain helpers**

Add only helpers needed by the flow test.

- [ ] **Step 4: Run focused test**

Run: `node scripts/test-frontend-app-flow.mjs`
Expected: PASS.

## Task 5: App Wiring and Contract Guard

**Files:**
- Modify: `src/app.js`
- Create: `scripts/test-frontend-contracts.mjs`
- Create: feature boundary README files under `src/features/*/README.md`
- Modify: `package.json`

- [ ] **Step 1: Write static contract test**

Assert no `fetch('/api` or `fetch(\`/api` exists in `src/app.js`, and assert the new API imports are present.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-frontend-contracts.mjs`
Expected: FAIL until `src/app.js` imports domain APIs.

- [ ] **Step 3: Wire selected app flows**

Replace login, email-code, project list, app state, pull list/decision, and observability direct calls with domain APIs. Keep UI behavior unchanged.

- [ ] **Step 4: Add feature README boundaries**

Create concise README files explaining ownership of command-center, work-graph, pr-pipeline, and observability features.

- [ ] **Step 5: Register tests in `npm run check`**

Add `node --check` and execution for all new test scripts.

- [ ] **Step 6: Run full verification**

Run: `npm run check`
Expected: PASS.

## Self-Review

- Spec coverage: API layer, state layer, feature boundaries, node tests, integration tests, contract tests, and workflow are covered.
- Placeholder scan: no TODO/TBD placeholders are allowed in implementation.
- Type consistency: all modules use plain JavaScript ESM with `createXApi(client)` factory pattern.
