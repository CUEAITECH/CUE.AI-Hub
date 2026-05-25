import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isV2AppPath,
  toLegacyApiUrl,
  handleV2AppRequest,
} from '../server/v2/appFacade.js';

const loginUrl = new URL('http://localhost/v2/app/auth/login?projectId=cue_ai_classroom');
const legacyLoginUrl = toLegacyApiUrl(loginUrl);
assert.equal(isV2AppPath(loginUrl), true);
assert.equal(legacyLoginUrl.pathname, '/api/auth/login');
assert.equal(legacyLoginUrl.search, '?projectId=cue_ai_classroom');

const rootUrl = new URL('http://localhost/v2/app');
assert.equal(toLegacyApiUrl(rootUrl).pathname, '/api');

let dispatchedPath = '';
const req = { method: 'POST', headers: {} };
const res = {
  statusCode: 0,
  body: '',
  writeHead(status) { this.statusCode = status; },
  end(body = '') { this.body = body; },
};

await handleV2AppRequest({
  req,
  res,
  url: loginUrl,
  requiresApiKey: () => false,
  hasValidApiKey: () => false,
  hasValidSession: () => false,
  sendError: () => { throw new Error('sendError should not be called'); },
  handleApi: async (_req, _res, url) => { dispatchedPath = `${url.pathname}${url.search}`; return true; },
});
assert.equal(dispatchedPath, '/api/auth/login?projectId=cue_ai_classroom');

let rejected = false;
await handleV2AppRequest({
  req: { method: 'POST', headers: {} },
  res,
  url: new URL('http://localhost/v2/app/tasks'),
  requiresApiKey: () => true,
  hasValidApiKey: () => false,
  hasValidSession: () => false,
  sendError: (_res, status, message) => {
    rejected = true;
    assert.equal(status, 401);
    assert.match(message, /invalid API key/);
  },
  handleApi: async () => { throw new Error('handleApi should not be called'); },
});
assert.equal(rejected, true);

const appSource = await readFile('src/app.js', 'utf8');
assert.match(appSource, /function toV2AppPath/);
assert.match(appSource, /fetch\(requestPath,/);
assert.match(appSource, /\/v2\/app/);

console.log('V2 app facade migration OK');
