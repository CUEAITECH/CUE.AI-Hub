# CUE Project Hub v2 Frontend Foundation Design

> Date: 2026-05-25
> Status: Approved direction B, ready for implementation planning
> Scope: v2 frontend foundation, professional workflow, integration tests, node-level tests

## Context

The current browser app is operational after the `/v2/app/*` facade change, but its shape is still v1-oriented:

- `src/app.js` owns global state, data fetching, event handlers, render functions, and route switching in one large file.
- Main product flows still think in legacy business bundles such as `GET /state`, assignments, reports, scoring, and project panels.
- Native v2 concepts already exist in backend routes: actors, events, outcomes, memory, recommendations, observability, sync, pulls, reviews, and learning.
- v2 UI patches for recommendation reasons, realtime PR checklist, SPACE, timeline, and observability were appended late in `src/app.js` rather than becoming the organizing model.

This phase should not redesign the whole product surface in one move. It should create the engineering foundation that lets the frontend migrate safely from v1 panels to v2 resource and event workflows.

## Decision

Proceed with **Option B: v2 frontend foundation and test system first**.

This means:

1. Build a typed-by-convention API boundary under `src/api/`.
2. Extract domain stores/selectors under `src/state/`.
3. Establish feature boundaries under `src/features/`.
4. Add node-level and integration tests before moving major UI logic.
5. Keep the existing UI working during every step.

This is not a visual redesign sprint. It is an architecture and testability sprint.

## Goals

- Frontend business code should stop calling `fetch()` directly for app API calls.
- Legacy `/api/*` paths should only appear inside the v2 facade compatibility layer or explicit regression tests.
- New v2-native features should be built against domain clients and stores, not global mutable state.
- Tests should prove endpoint mapping, state transformations, selectors, and critical app flows.
- Each migration slice should be small enough to review, commit, and roll back independently.

## Non-Goals

- Do not rewrite `src/app.js` wholesale.
- Do not introduce React/Vue/Svelte in this sprint.
- Do not replace all legacy `/v2/app/*` facade calls with native `/v2/*` resources in one PR.
- Do not redesign the visual system or navigation layout in this sprint.
- Do not remove existing legacy route modules until equivalent v2-native clients and tests exist.

## Target Frontend Architecture

```text
src/
  api/
    httpClient.js
    authApi.js
    projectsApi.js
    appStateApi.js
    tasksApi.js
    pullsApi.js
    eventsApi.js
    observabilityApi.js
  state/
    sessionStore.js
    projectStore.js
    taskStore.js
    pullStore.js
    eventStore.js
    observabilityStore.js
    selectors.js
  features/
    command-center/
    work-graph/
    pr-pipeline/
    observability/
  tests/
    frontend/
      api-client.test.mjs
      stores.test.mjs
      app-flow.test.mjs
```

The first implementation can keep files under `src/` and `scripts/` because the repo currently uses script-based tests, but the boundary names above should be preserved.

## API Layer

`src/api/httpClient.js` owns request mechanics:

- JSON headers.
- session token injection.
- v2 facade mapping for legacy app APIs.
- error normalization.
- test hooks for fake fetch.

Domain API modules own product semantics:

- `authApi.loginPassword()`, `authApi.loginEmailCode()`, `authApi.me()`, `authApi.sendEmailCode()`
- `projectsApi.listProjects()`
- `appStateApi.loadProjectState(projectId)`
- `tasksApi.createTask()`, `tasksApi.updateTask()`, `tasksApi.deleteTask()`
- `pullsApi.listPulls()`, `pullsApi.submitDecision()`
- `eventsApi.streamPrReviews()`, `eventsApi.getGroupedEvents()`
- `observabilityApi.getLlmStats()`, `getEvents()`, `getSyncHealth()`

Rules:

- UI code must call domain APIs, not raw `fetch()`, for app requests.
- Direct native `/v2/*` calls are allowed only inside `src/api/*`.
- `src/app.js` may keep legacy call sites temporarily, but new or migrated flows must use the API modules.

## State Layer

State modules own data updates and selectors:

- `sessionStore`: token, current user, auth state.
- `projectStore`: selected project and project list.
- `taskStore`: task list, task updates, recommendation explanation cache.
- `pullStore`: PR list, selected PR, realtime AC updates.
- `eventStore`: grouped events and SSE event merge.
- `observabilityStore`: LLM stats, sync health, event filters.

Rules:

- Stores should be plain JavaScript modules with pure update functions where possible.
- UI render functions should consume selectors instead of reaching into large global state directly after migration.
- Store tests should run in Node without browser DOM.

## Feature Boundaries

Sprint 1 should create boundaries, not fully move every line:

1. `features/command-center`
   - Future home for dashboard, risk, next action, event summaries.
2. `features/pr-pipeline`
   - Future home for PR list, drawer, AC checklist, human decision.
3. `features/observability`
   - Future home for LLM ledger, event stream, sync health.
4. `features/work-graph`
   - Future home for tasks, deliverables, phase graph, assignment evidence.

The initial implementation may move only API and store logic, leaving most rendering in `src/app.js`.

## Testing Strategy

Use a layered test suite.

### Node-Level Tests

Run without server or browser:

- `scripts/test-frontend-api-client.mjs`
  - `/api/auth/login` maps to `/v2/app/auth/login`.
  - `/v2/observability/llm` stays `/v2/observability/llm`.
  - session token is injected.
  - error payloads normalize to useful `Error.message`.

- `scripts/test-frontend-stores.mjs`
  - session login stores token and user.
  - project selection resolves default project.
  - task update merges by id.
  - PR review event updates selected pull checklist.

### Integration Tests

Run against module boundaries with fake fetch/server dispatch:

- login password flow calls auth API, stores token, then loads state.
- email-code login calls send-code then login.
- project switch calls app state load and scoring endpoints through domain APIs.
- observability panel calls native `/v2/observability/*` APIs, not `/v2/app/*`.

### Contract/Regression Tests

- No raw `fetch('/api` or `fetch(\`/api` remains outside allowed compatibility files.
- No new app business API call is added directly in render code.
- `npm run check` includes all frontend foundation tests.

## Workflow

Adopt this working agreement for every migration slice:

1. Write or extend a failing test.
2. Implement the smallest module change.
3. Run the focused test.
4. Run `npm run check`.
5. Commit only the relevant files.
6. Keep DB WAL/SHM and coverage artifacts out of commits.

Recommended commit slices:

1. API client foundation.
2. Auth/project/app-state domain APIs.
3. Store foundation and selectors.
4. PR/events/observability APIs.
5. Raw fetch guard and check integration.

## Acceptance Criteria

- `src/api/httpClient.js` exists and owns request mapping/error/session behavior.
- At least auth, projects, app state, pulls, events, and observability have domain API modules.
- At least session, project, task, pull, event, and observability stores/selectors exist.
- `src/app.js` uses domain API modules for login, project loading, state loading, pull list/decision, and observability.
- Tests cover API mapping, stores, and one login-to-load-state flow.
- `npm run check` passes.
- The browser app remains behaviorally compatible with the current deployed UI.

## Risks

- Moving too much rendering logic at once would create visual regressions.
- A fake store abstraction that only wraps global state without tests would add indirection without value.
- Native v2 endpoints are not complete enough to remove the facade immediately.
- Server startup is currently not reliable enough in local verification, so Sprint 1 should emphasize module and contract tests first.

## Rollback Plan

Each slice is isolated. If a migrated call breaks, revert the domain module usage in `src/app.js` back to `api('/api/...')`; the `/v2/app/*` facade remains as a compatibility layer.
