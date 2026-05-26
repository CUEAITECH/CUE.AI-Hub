# V2 App Facade Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the main browser app off direct `/api/*` requests so login and the rest of the app work while v1 is disabled.

**Architecture:** Add a narrow `/v2/app/*` facade in `server/index.js` that rewrites to the existing legacy route dispatcher internally. Update `src/app.js` so its `api()` helper maps `/api/foo` to `/v2/app/foo`; direct `/v2/*` observability/event calls stay unchanged.

**Tech Stack:** Node.js ESM, native `http`, existing route modules, plain browser JavaScript, assertion-based regression scripts.

---

### Task 1: V2 App Facade Helper

**Files:**
- Create: `server/v2/appFacade.js`
- Create: `scripts/test-v2-app-facade.mjs`
- Modify: `package.json`

- [ ] Write a failing test that imports `toLegacyApiUrl` and expects `/v2/app/auth/login?x=1` to become `/api/auth/login?x=1`.
- [ ] Implement `isV2AppPath()` and `toLegacyApiUrl()`.
- [ ] Add the new test script to `npm run check`.

### Task 2: Server Routing

**Files:**
- Modify: `server/index.js`
- Modify: `scripts/test-v2-app-facade.mjs`

- [ ] Extend the test with `handleV2AppRequest()` using a fake dispatcher and fake response.
- [ ] In `server/index.js`, handle `/v2/app/*` before the generic `/v2/*` Fastify branch.
- [ ] Preserve existing API-key/session behavior by applying `requiresApiKey`, `hasValidApiKey`, and `hasValidSession` against the rewritten `/api/*` URL before dispatching.

### Task 3: Frontend Request Migration

**Files:**
- Modify: `src/app.js`
- Modify: `scripts/test-v2-app-facade.mjs`

- [ ] Add a static regression assertion that `api()` rewrites `/api/*` to `/v2/app/*`.
- [ ] Update `api()` to compute `requestPath` and call `fetch(requestPath, ...)`.
- [ ] Keep existing explicit `/v2/*` fetch and `EventSource` calls unchanged.

### Task 4: Verification

**Files:**
- No new files.

- [ ] Run `node scripts/test-v2-app-facade.mjs`.
- [ ] Run `npm run check`.
- [ ] If a local server is needed for manual login verification, start it on an available port and test `/v2/app/projects` and `/api/projects` behavior with `curl`.
