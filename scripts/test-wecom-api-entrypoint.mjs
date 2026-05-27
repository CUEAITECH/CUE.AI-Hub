import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('server/index.js', 'utf8');

const wecomAllowIndex = source.indexOf("url.pathname.startsWith('/api/wecom/')");
const v1DisabledIndex = source.indexOf("v1 API disabled");

assert.ok(wecomAllowIndex > 0, 'server entrypoint must explicitly allow /api/wecom/*');
assert.ok(v1DisabledIndex > 0, 'server entrypoint must keep the v1 /api disabled guard');
assert.ok(
  wecomAllowIndex < v1DisabledIndex,
  '/api/wecom/* allowlist must run before the generic v1 /api disabled guard'
);

const wecomAllowBlock = source.slice(wecomAllowIndex, v1DisabledIndex);
assert.match(wecomAllowBlock, /await handleApi\(req, res, url\)/);
assert.match(wecomAllowBlock, /req\.method === 'OPTIONS'/);

console.log('WeCom API entrypoint allowlist OK');
