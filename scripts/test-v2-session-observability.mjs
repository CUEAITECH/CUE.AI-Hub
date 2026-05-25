import assert from 'node:assert/strict';
import { handleV2 } from '../server/v2/app.js';
import { initDb } from '../server/db/index.js';
import { createSessionToken } from '../server/services/auth.js';

initDb();

function makeHttpCtx({ method = 'GET', pathname = '/v2/observability/llm', headers = {} } = {}) {
  const req = {
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, callback) {
      if (event === 'end') callback();
      return this;
    },
  };
  const url = new URL(`http://localhost${pathname}`);
  let status = 0;
  let rawBody = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(body = '') {
      rawBody += body;
    },
    status() {
      return status;
    },
    body() {
      try {
        return JSON.parse(rawBody || '{}');
      } catch {
        return rawBody;
      }
    },
  };
  return { req, res, url };
}

const originalApiKey = process.env.CUE_API_KEY;
process.env.CUE_API_KEY = 'server_secret_for_browser_session_test';

try {
  const token = createSessionToken({
    id: 'u_session_observability',
    username: 'observer',
    role: 'admin',
    projectRoles: { cue_ai_classroom: 'admin' },
  }, 'cue_ai_classroom');

  const { req, res, url } = makeHttpCtx({
    headers: {
      'x-cue-session-token': token,
      'x-tenant-id': 'default',
    },
  });
  await handleV2(req, res, url);

  assert.equal(res.status(), 200);
  assert.equal(typeof res.body(), 'object');
} finally {
  if (originalApiKey) process.env.CUE_API_KEY = originalApiKey;
  else delete process.env.CUE_API_KEY;
}

console.log('V2 session observability auth OK');
