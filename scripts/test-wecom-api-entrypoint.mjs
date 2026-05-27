import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('server/index.js', 'utf8');

const externalAllowIndex = source.indexOf('function isLegacyExternalApiPath');
const v1DisabledIndex = source.indexOf("v1 API disabled");

assert.ok(externalAllowIndex > 0, 'server entrypoint must define legacy external API allowlist');
assert.ok(v1DisabledIndex > 0, 'server entrypoint must keep the v1 /api disabled guard');
assert.ok(
  externalAllowIndex < v1DisabledIndex,
  'legacy external API allowlist must run before the generic v1 /api disabled guard'
);

const allowBlock = source.slice(externalAllowIndex, v1DisabledIndex);
for (const path of [
  '/api/health',
  '/api/config',
  '/api/openapi.json',
  '/api/webhooks/github',
  '/api/webhooks/pr-agent',
  '/api/webhooks/bypass',
  '/api/wecom/',
]) {
  assert.ok(allowBlock.includes(path), `${path} must remain available for external integrations`);
}
assert.match(allowBlock, /await handleApi\(req, res, url\)/);
assert.match(allowBlock, /req\.method === 'OPTIONS'/);
assert.doesNotMatch(allowBlock, /\/api\/tasks['"]/);

console.log('Legacy external API entrypoint allowlist OK');
