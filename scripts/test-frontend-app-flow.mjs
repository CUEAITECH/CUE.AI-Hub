import assert from 'node:assert/strict';
import { createHttpClient } from '../src/api/httpClient.js';
import { createAuthApi } from '../src/api/authApi.js';
import { createAppStateApi } from '../src/api/appStateApi.js';
import { createObservabilityApi } from '../src/api/observabilityApi.js';
import { applyLogin } from '../src/state/sessionStore.js';

const calls = [];
let token = '';
const responses = new Map([
  ['/v2/app/auth/login', { token: 'tok_1', user: { name: 'Alice', projectRole: 'project_admin' } }],
  ['/v2/app/state?projectId=p1', { tasks: [{ id: 't1' }], projects: [{ id: 'p1' }] }],
  ['/v2/observability/llm', { total: 3 }],
]);

const client = createHttpClient({
  getSessionToken: () => token,
  fetchImpl: async (path, options) => {
    calls.push({ path, options });
    const payload = responses.get(path);
    return payload
      ? { ok: true, json: async () => payload }
      : { ok: false, status: 404, json: async () => ({ error: `missing ${path}` }) };
  },
});

const authApi = createAuthApi(client);
const appStateApi = createAppStateApi(client);
const observabilityApi = createObservabilityApi(client);

const login = await authApi.loginPassword({ username: 'alice', password: 'pw', projectId: 'p1' });
const session = applyLogin({}, login);
token = session.token;
const appState = await appStateApi.loadProjectState('p1');
const llm = await observabilityApi.getLlmStats();

assert.equal(session.user.name, 'Alice');
assert.equal(appState.tasks[0].id, 't1');
assert.equal(llm.total, 3);
assert.deepEqual(calls.map((call) => call.path), [
  '/v2/app/auth/login',
  '/v2/app/state?projectId=p1',
  '/v2/observability/llm',
]);
assert.equal(calls[1].options.headers['X-CUE-Session-Token'], 'tok_1');

console.log('frontend app flow tests OK');
