import assert from 'node:assert/strict';
import {
  createHttpClient,
  toV2RequestPath,
} from '../src/api/httpClient.js';
import { createAuthApi } from '../src/api/authApi.js';
import { createProjectsApi } from '../src/api/projectsApi.js';
import { createAppStateApi } from '../src/api/appStateApi.js';
import { createTasksApi } from '../src/api/tasksApi.js';
import { createPullsApi } from '../src/api/pullsApi.js';
import { createEventsApi } from '../src/api/eventsApi.js';
import { createObservabilityApi } from '../src/api/observabilityApi.js';

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
  fetchImpl: async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'boom', details: 'detail' }),
  }),
});
await assert.rejects(() => failing.request('/api/state'), /boom：detail/);

const domainCalls = [];
const fakeClient = {
  request: async (path, options = {}) => {
    domainCalls.push({ path, options });
    return { ok: true, path, options };
  },
};

await createAuthApi(fakeClient).loginPassword({ username: 'alice', password: 'pw', projectId: 'p1' });
await createAuthApi(fakeClient).sendEmailCode({ email: 'a@example.com', purpose: 'login', projectId: 'p1' });
await createProjectsApi(fakeClient).listProjects();
await createAppStateApi(fakeClient).loadProjectState('p1');
await createTasksApi(fakeClient).updateTask('t1', { title: 'T' });
await createPullsApi(fakeClient).listPulls({ projectId: 'p1', state: 'open' });
await createEventsApi(fakeClient).getGroupedEvents({ hours: 24 });
await createObservabilityApi(fakeClient).getLlmStats();

assert.deepEqual(domainCalls.map((c) => c.path), [
  '/api/auth/login',
  '/api/auth/email-code',
  '/api/projects',
  '/api/state?projectId=p1',
  '/api/tasks/t1',
  '/api/pulls?projectId=p1&state=open',
  '/v2/events/grouped?hours=24',
  '/v2/observability/llm',
]);
assert.equal(domainCalls[0].options.method, 'POST');
assert.match(domainCalls[0].options.body, /"username":"alice"/);
assert.equal(domainCalls[4].options.method, 'PATCH');

console.log('frontend API client tests OK');
