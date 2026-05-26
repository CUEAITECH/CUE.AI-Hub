/**
 * test-frontend-api-extended.mjs
 *
 * 验收条件：
 *   1. tasksApi.getTaskExplanation → 正确路径 + X-Tenant-Id 头注入
 *   2. observabilityApi.getEvents → 查询参数序列化正确
 *   3. observabilityApi.getSpace   → 正确路径
 *   4. eventsApi.prReviewStreamUrl → 返回正确 SSE URL
 *   5. httpClient 错误格式化（error: + details: 字段组合）
 *   6. buildQuery 边界：空参数 / null / 空字符串都不产生查询串
 */

import assert from 'node:assert/strict';
import { createHttpClient, toV2RequestPath } from '../src/api/httpClient.js';
import { createTasksApi } from '../src/api/tasksApi.js';
import { createObservabilityApi } from '../src/api/observabilityApi.js';
import { createEventsApi } from '../src/api/eventsApi.js';
import { createPullsApi } from '../src/api/pullsApi.js';
import { createAuthApi } from '../src/api/authApi.js';
import { createProjectsApi } from '../src/api/projectsApi.js';

const calls = [];
const fakeClient = {
  request: async (path, options = {}) => {
    calls.push({ path, options });
    return { ok: true, path, options };
  },
};

// ── 1. tasksApi.getTaskExplanation ─────────────────────────────────────────
calls.length = 0;
const tasksApi = createTasksApi(fakeClient);
await tasksApi.getTaskExplanation('task_abc');
assert.equal(calls[0].path, '/v2/tasks/task_abc/explanation',
  'getTaskExplanation path must be /v2/tasks/:id/explanation');
// No X-Tenant-Id when tenantId is empty string (default 'default')
assert.equal(calls[0].options.headers['X-Tenant-Id'], 'default',
  'getTaskExplanation must send X-Tenant-Id: default');

calls.length = 0;
await tasksApi.getTaskExplanation('t2', 'proj_99');
assert.equal(calls[0].options.headers['X-Tenant-Id'], 'proj_99',
  'getTaskExplanation must forward custom tenantId');

console.log('✓ tasksApi.getTaskExplanation: path + tenant header OK');

// ── 2. observabilityApi.getEvents query params ────────────────────────────
calls.length = 0;
const obsApi = createObservabilityApi(fakeClient);
await obsApi.getEvents({ limit: 20, type: 'llm.call' });
assert.ok(calls[0].path.includes('limit=20'), 'getEvents must include limit param');
assert.ok(calls[0].path.includes('type=llm.call'), 'getEvents must include type param');

calls.length = 0;
await obsApi.getEvents({});
assert.equal(calls[0].path, '/v2/observability/events', 'empty params → no query string');

calls.length = 0;
await obsApi.getEvents({ type: '', limit: null });
assert.ok(!calls[0].path.includes('?'), 'empty/null params must not produce query string');

console.log('✓ observabilityApi.getEvents: query serialization OK');

// ── 3. observabilityApi.getSpace ──────────────────────────────────────────
calls.length = 0;
await obsApi.getSpace();
assert.equal(calls[0].path, '/v2/space', 'getSpace must call /v2/space');

calls.length = 0;
await obsApi.getSpace('tenant_1');
assert.equal(calls[0].options.headers['X-Tenant-Id'], 'tenant_1',
  'getSpace with tenantId must send X-Tenant-Id header');

console.log('✓ observabilityApi.getSpace: path + header OK');

// ── 4. eventsApi.prReviewStreamUrl ────────────────────────────────────────
const eventsApi = createEventsApi(fakeClient);
const defaultUrl = eventsApi.prReviewStreamUrl();
assert.ok(defaultUrl.startsWith('/v2/events/stream'), 'SSE URL must start with /v2/events/stream');
assert.ok(defaultUrl.includes('type=pr.review.posted'), 'default SSE type must be pr.review.posted');

const customUrl = eventsApi.prReviewStreamUrl('llm.call');
assert.ok(customUrl.includes('type=llm.call'), 'custom SSE type must be in URL');

// URL must be properly encoded
const encodedUrl = eventsApi.prReviewStreamUrl('pr.review.posted');
assert.ok(!encodedUrl.includes(' '), 'SSE URL must not contain unencoded spaces');

console.log('✓ eventsApi.prReviewStreamUrl: SSE URL construction OK');

// ── 5. eventsApi.getGroupedEvents ─────────────────────────────────────────
calls.length = 0;
await eventsApi.getGroupedEvents({ hours: 24 });
assert.ok(calls[0].path.includes('hours=24'), 'getGroupedEvents hours param OK');

calls.length = 0;
await eventsApi.getGroupedEvents({}, 'tenant_x');
assert.equal(calls[0].options.headers['X-Tenant-Id'], 'tenant_x',
  'getGroupedEvents tenantId forwarded OK');

console.log('✓ eventsApi.getGroupedEvents: params + tenant header OK');

// ── 6. httpClient error formatting ───────────────────────────────────────
const errClient = createHttpClient({
  fetchImpl: async () => ({
    ok: false,
    status: 422,
    json: async () => ({ error: '验证失败', details: '字段 title 不能为空' }),
  }),
});
await assert.rejects(
  () => errClient.request('/api/tasks'),
  (err) => {
    assert.ok(err.message.includes('验证失败'), 'error message must include error field');
    assert.ok(err.message.includes('字段 title 不能为空'), 'error message must include details field');
    return true;
  },
);
console.log('✓ httpClient error format: error + details joined OK');

// ── 7. httpClient: no auth header when no session token ──────────────────
calls.length = 0;
const noTokenClient = createHttpClient({
  fetchImpl: async (path, options) => {
    calls.push({ path, options });
    return { ok: true, json: async () => ({}) };
  },
  getSessionToken: () => '',
});
await noTokenClient.request('/api/state');
assert.ok(!calls[0].options.headers['X-CUE-Session-Token'],
  'no session token → X-CUE-Session-Token must be omitted');
console.log('✓ httpClient: omits session header when no token OK');

// ── 8. toV2RequestPath rewrite rules ─────────────────────────────────────
assert.equal(toV2RequestPath('/api/auth/login'),     '/v2/app/auth/login');
assert.equal(toV2RequestPath('/api/state'),          '/v2/app/state');
assert.equal(toV2RequestPath('/api/tasks/t1'),       '/v2/app/tasks/t1');
assert.equal(toV2RequestPath('/v2/observability/llm'), '/v2/observability/llm');
assert.equal(toV2RequestPath('/v2/space'),           '/v2/space');
assert.equal(toV2RequestPath('/v2/events/stream'),   '/v2/events/stream');
// Non-/api/ paths must pass through unchanged
assert.equal(toV2RequestPath('/v2/tasks/t1/explanation'), '/v2/tasks/t1/explanation');
console.log('✓ toV2RequestPath: URL rewrite rules OK');

// ── 9. pullsApi methods ───────────────────────────────────────────────────
calls.length = 0;
const pullsApi = createPullsApi(fakeClient);
await pullsApi.listPulls({ projectId: 'p1', state: 'open' });
assert.ok(calls[0].path.includes('/api/pulls'), 'listPulls path OK');
assert.ok(calls[0].path.includes('projectId=p1'), 'listPulls projectId param OK');
assert.ok(calls[0].path.includes('state=open'), 'listPulls state param OK');

calls.length = 0;
await pullsApi.submitDecision('pr_1', { decision: 'LGTM', comment: '看起来不错' });
assert.equal(calls[0].options.method, 'PATCH', 'submitDecision must PATCH');
assert.ok(calls[0].path.includes('pr_1'), 'submitDecision path includes prId');

console.log('✓ pullsApi: listPulls + submitDecision OK');

// ── 10. authApi coverage ──────────────────────────────────────────────────
calls.length = 0;
const authApi = createAuthApi(fakeClient);
await authApi.loginPassword({ username: 'alice', password: 'pw', projectId: 'p1' });
assert.equal(calls[0].options.method, 'POST', 'loginPassword must POST');
assert.match(calls[0].options.body, /"username":"alice"/, 'loginPassword body includes username');

calls.length = 0;
await authApi.sendEmailCode({ email: 'alice@example.com', purpose: 'login', projectId: 'p1' });
assert.equal(calls[0].path, '/api/auth/email-code', 'sendEmailCode path OK');
assert.match(calls[0].options.body, /"email":"alice@example.com"/, 'sendEmailCode body includes email');

calls.length = 0;
await authApi.loginEmailCode({ username: 'alice', emailCode: '123456', projectId: 'p1' });
// loginEmailCode shares the /api/auth/login endpoint (different body field: emailCode vs password)
assert.equal(calls[0].path, '/api/auth/login', 'loginEmailCode uses /api/auth/login endpoint');
assert.match(calls[0].options.body, /"emailCode":"123456"/, 'loginEmailCode body includes emailCode field');

console.log('✓ authApi: loginPassword + sendEmailCode + loginEmailCode OK');

// ── 11. projectsApi coverage ──────────────────────────────────────────────
calls.length = 0;
const projectsApi = createProjectsApi(fakeClient);
await projectsApi.listProjects();
assert.equal(calls[0].path, '/api/projects', 'listProjects path OK');

calls.length = 0;
await projectsApi.listProjects();
assert.equal(calls[0].options.method, undefined, 'listProjects uses GET (no method override)');

console.log('✓ projectsApi: listProjects OK');

console.log('\nAll extended API client tests passed ✓');
