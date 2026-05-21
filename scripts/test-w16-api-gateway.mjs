/**
 * test-w16-api-gateway.mjs
 * W16: 公开 API 网关 — API Key 认证 + Rate Limiting + 多租户隔离
 * 运行：node scripts/test-w16-api-gateway.mjs
 */

import { initDb, getDb } from '../server/db/index.js';
import {
  ensureGatewayTables,
  generateApiKey,
  validateApiKey,
  revokeApiKey,
  listApiKeys,
  checkRateLimit,
  resetRateLimit,
  auditLog,
  queryAuditLog,
  assertTenantIsolation,
  extractApiKey,
  gatewayAuth,
} from '../server/middleware/apiGateway.js';

// ─── test helpers ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✗\x1b[0m ${label}`);
    failed++;
  }
}

function assertEq(a, b, label) {
  if (a === b) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✗\x1b[0m ${label} — got: ${JSON.stringify(a)}, expected: ${JSON.stringify(b)}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n\x1b[36m[${name}]\x1b[0m`);
}

// ─── setup ───────────────────────────────────────────────────────────────────
initDb();
const tenantId = `test_w16_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const tenantId2 = `test_w16b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
ensureGatewayTables();

// ═══════════════════════════════════════════════════════════════════════════
console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
console.log('  W16 公开 API 网关 测试');
console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');

// ─── Step 1: generateApiKey ───────────────────────────────────────────────────
section('Step 1: generateApiKey');

const keyResult = await generateApiKey({
  tenantId,
  name: 'test-key-1',
  scopes: ['read', 'write'],
  rateLimit: 60,
});

assert(keyResult.key.startsWith('cue_'), 'key 以 cue_ 开头');
assert(keyResult.key.includes(tenantId), 'key 包含 tenantId');
assert(keyResult.key.length > 30, 'key 长度 > 30');
assertEq(typeof keyResult.keyHash, 'string', 'keyHash 是字符串');
assertEq(keyResult.keyPrefix.slice(0, 4), 'cue_', 'keyPrefix 以 cue_ 开头');
assertEq(keyResult.tenantId, tenantId, 'tenantId 正确');
assert(Array.isArray(keyResult.scopes), 'scopes 是数组');
assertEq(keyResult.rateLimit, 60, 'rateLimit = 60');

// ─── Step 2: validateApiKey 成功路径 ──────────────────────────────────────────
section('Step 2: validateApiKey 成功路径');

const validInfo = await validateApiKey(keyResult.key);
assert(validInfo !== null, 'validateApiKey 返回非 null');
assertEq(validInfo.tenantId, tenantId, 'tenantId 匹配');
assert(validInfo.scopes.includes('read'), 'scopes 含 read');
assert(validInfo.scopes.includes('write'), 'scopes 含 write');
assertEq(validInfo.rateLimit, 60, 'rateLimit = 60');
assertEq(typeof validInfo.keyPrefix, 'string', 'keyPrefix 存在');

// ─── Step 3: validateApiKey 失败路径 ──────────────────────────────────────────
section('Step 3: validateApiKey 失败路径');

const nullResult = await validateApiKey(null);
assert(nullResult === null, 'null key → null');

const emptyResult = await validateApiKey('');
assert(emptyResult === null, '空字符串 → null');

const wrongResult = await validateApiKey('cue_' + tenantId + '_invalidhex');
assert(wrongResult === null, '不存在的 key → null');

const wrongPrefix = await validateApiKey('sk-not-cue-format');
assert(wrongPrefix === null, '非 cue_ 前缀 → null');

// ─── Step 4: revokeApiKey ─────────────────────────────────────────────────────
section('Step 4: revokeApiKey');

const revokeKey = await generateApiKey({ tenantId, name: 'to-revoke' });

// 撤销前可验证
const beforeRevoke = await validateApiKey(revokeKey.key);
assert(beforeRevoke !== null, '撤销前验证成功');

const revokeOk = await revokeApiKey({ tenantId, keyId: revokeKey.id });
assert(revokeOk === true, 'revokeApiKey 返回 true');

// 撤销后无法验证
const afterRevoke = await validateApiKey(revokeKey.key);
assert(afterRevoke === null, '撤销后验证失败');

// 撤销不存在的 key
const notFound = await revokeApiKey({ tenantId, keyId: 999999 });
assert(notFound === false, '不存在的 keyId 返回 false');

// 跨租户撤销失败
const otherKey = await generateApiKey({ tenantId: tenantId2, name: 'other' });
const crossRevoke = await revokeApiKey({ tenantId, keyId: otherKey.id }); // 用 tenantId 撤销 tenantId2 的 key
assert(crossRevoke === false, '跨租户撤销返回 false');

// ─── Step 5: listApiKeys ──────────────────────────────────────────────────────
section('Step 5: listApiKeys');

const keys = listApiKeys({ tenantId });
assert(Array.isArray(keys), 'listApiKeys 返回数组');
assert(keys.length >= 1, '至少有 1 个 key（revokeKey 已撤销，但还有 keyResult）');
// 不应该包含完整 key（只有 keyPrefix）
for (const k of keys) {
  assert(k.key === undefined, `key ${k.key_prefix} 不含完整 key 字段`);
  assert(typeof k.key_prefix === 'string', 'key_prefix 存在');
  assert(Array.isArray(k.scopes), 'scopes 是数组');
}

// ─── Step 6: checkRateLimit ───────────────────────────────────────────────────
section('Step 6: checkRateLimit — 滑动窗口');

const testHash = `testhash_${tenantId.slice(-8)}`;
resetRateLimit(testHash); // 清零

const limit = 5;
for (let i = 0; i < limit; i++) {
  const result = checkRateLimit(testHash, limit);
  assert(result.allowed === true, `第 ${i + 1} 次请求允许`);
  assertEq(result.limit, limit, 'limit 正确');
}

// 第 6 次超限
const exceeded = checkRateLimit(testHash, limit);
assert(exceeded.allowed === false, `第 ${limit + 1} 次请求被限速`);
assertEq(exceeded.remaining, 0, 'remaining = 0');
assert(exceeded.resetAt > Date.now(), 'resetAt 在未来');

// 重置后可以再次请求
resetRateLimit(testHash);
const afterReset = checkRateLimit(testHash, limit);
assert(afterReset.allowed === true, '重置后可以请求');

// ─── Step 7: assertTenantIsolation ───────────────────────────────────────────
section('Step 7: assertTenantIsolation — 多租户隔离');

assert(assertTenantIsolation('tenant-a', 'tenant-a'), '相同 tenant 允许');
assert(!assertTenantIsolation('tenant-a', 'tenant-b'), '不同 tenant 拒绝');
assert(assertTenantIsolation('default', 'tenant-any'), 'default 租户有全局权限');
assert(assertTenantIsolation('default', 'default'), 'default 自访问允许');

// ─── Step 8: extractApiKey ───────────────────────────────────────────────────
section('Step 8: extractApiKey — 从请求头提取');

// Authorization: Bearer cue_xxx
const req1 = { headers: { authorization: 'Bearer cue_test_abc123' } };
assertEq(extractApiKey(req1), 'cue_test_abc123', 'Bearer Token 提取');

// X-API-Key: cue_xxx
const req2 = { headers: { 'x-api-key': 'cue_test_xyz789' } };
assertEq(extractApiKey(req2), 'cue_test_xyz789', 'X-API-Key 提取');

// X-CUE-API-Key（兼容旧格式）
const req3 = { headers: { 'x-cue-api-key': 'legacy-key-no-prefix' } };
assertEq(extractApiKey(req3), 'legacy-key-no-prefix', 'X-CUE-API-Key 兼容');

// 无 key
const req4 = { headers: {} };
assert(extractApiKey(req4) === null, '无 key 返回 null');

// Bearer 但非 cue_ 前缀（忽略）
const req5 = { headers: { authorization: 'Bearer sk-other-format' } };
assert(extractApiKey(req5) === null, '非 cue_ Bearer token 返回 null');

// ─── Step 9: gatewayAuth — 完整鉴权流程 ──────────────────────────────────────
section('Step 9: gatewayAuth — 完整鉴权流程');

// 无 key → 401
const noKeyReq = { headers: {} };
const auth1 = await gatewayAuth(noKeyReq);
assert(auth1.ok === false, '无 key → ok=false');
assertEq(auth1.errorCode, 401, '无 key → 401');

// 无效 key → 401
const invalidKeyReq = { headers: { 'x-api-key': 'cue_invalid_key_here' } };
const auth2 = await gatewayAuth(invalidKeyReq);
assert(auth2.ok === false, '无效 key → ok=false');
assertEq(auth2.errorCode, 401, '无效 key → 401');

// 有效 key → 成功
const validKeyReq = { headers: { 'x-api-key': keyResult.key } };
const auth3 = await gatewayAuth(validKeyReq);
assert(auth3.ok === true, '有效 key → ok=true');
assertEq(auth3.tenantId, tenantId, '提取正确 tenantId');
assert(Array.isArray(auth3.scopes), '返回 scopes');
assert(auth3.rateLimitInfo !== undefined, '返回 rateLimitInfo');

// 有效 key + 租户隔离验证（正确）
const auth4 = await gatewayAuth(validKeyReq, tenantId);
assert(auth4.ok === true, '正确 tenantId 通过隔离检查');

// 有效 key + 租户隔离验证（失败）
const auth5 = await gatewayAuth(validKeyReq, 'other-tenant');
assert(auth5.ok === false, '错误 tenantId 拒绝访问');
assertEq(auth5.errorCode, 403, 'tenant 隔离违规 → 403');

// ─── Step 10: gatewayAuth — Rate Limit 触发 ───────────────────────────────────
section('Step 10: gatewayAuth — Rate Limit 触发');

// 生成低限额 key（每分钟 2 次）
const lowLimitKey = await generateApiKey({ tenantId, name: 'low-limit', rateLimit: 2 });
const lowLimitReq = { headers: { 'x-api-key': lowLimitKey.key } };

const rl1 = await gatewayAuth(lowLimitReq);
assert(rl1.ok === true, '第 1 次请求允许');

const rl2 = await gatewayAuth(lowLimitReq);
assert(rl2.ok === true, '第 2 次请求允许');

const rl3 = await gatewayAuth(lowLimitReq);
assert(rl3.ok === false, '第 3 次请求被限速');
assertEq(rl3.errorCode, 429, '限速 → 429');
assert(rl3.errorMessage.includes('rate limit'), '错误信息含 rate limit');
assert(rl3.rateLimitInfo !== undefined, '返回 rateLimitInfo');

// ─── Step 11: auditLog + queryAuditLog ───────────────────────────────────────
section('Step 11: auditLog + queryAuditLog');

const now = new Date().toISOString();
auditLog({
  tenantId,
  keyPrefix: 'cue_test_x',
  method: 'GET',
  path: '/v2/tasks',
  statusCode: 200,
  latencyMs: 42,
  ip: '127.0.0.1',
});

auditLog({
  tenantId,
  keyPrefix: 'cue_test_x',
  method: 'POST',
  path: '/v2/tasks',
  statusCode: 201,
  latencyMs: 88,
});

// 等待 fire-and-forget 写入
await new Promise(r => setTimeout(r, 100));

const auditResult = queryAuditLog({ tenantId, since: now });
assert(auditResult.total >= 2, '至少有 2 条审计记录');
assert(Array.isArray(auditResult.logs), 'logs 是数组');

const getLog = auditResult.logs.find(l => l.method === 'GET' && l.path === '/v2/tasks');
assert(getLog !== undefined, '能找到 GET /v2/tasks 记录');
assertEq(getLog.status_code, 200, 'status_code = 200');
assertEq(getLog.latency_ms, 42, 'latency_ms = 42');
assertEq(getLog.ip, '127.0.0.1', 'ip 记录正确');

// path 过滤
const filteredResult = queryAuditLog({ tenantId, path: '/v2/tasks', since: now });
assert(filteredResult.logs.every(l => l.path.includes('/v2/tasks')), 'path 过滤正确');

// ─── Step 12: API Key 过期验证 ────────────────────────────────────────────────
section('Step 12: API Key 过期验证');

// 生成一个已过期的 key（expiresAt 在过去）
const expiredKey = await generateApiKey({
  tenantId,
  name: 'expired-key',
  expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 秒前过期
});

const expiredInfo = await validateApiKey(expiredKey.key);
assert(expiredInfo === null, '过期 key 验证返回 null');

// 未过期 key（正常）
const futureKey = await generateApiKey({
  tenantId,
  name: 'future-key',
  expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(), // 1 天后
});
const futureInfo = await validateApiKey(futureKey.key);
assert(futureInfo !== null, '未过期 key 验证通过');

// ─── Step 13: checkRateLimit 窗口重置 ─────────────────────────────────────────
section('Step 13: checkRateLimit — remaining 计算正确');

const counterHash = `counter_${tenantId.slice(-8)}`;
resetRateLimit(counterHash);

const r1 = checkRateLimit(counterHash, 10);
assertEq(r1.remaining, 9, '第 1 次后 remaining=9');

const r2 = checkRateLimit(counterHash, 10);
assertEq(r2.remaining, 8, '第 2 次后 remaining=8');

for (let i = 0; i < 8; i++) checkRateLimit(counterHash, 10);
const r11 = checkRateLimit(counterHash, 10);
assertEq(r11.allowed, false, '第 11 次超限');
assertEq(r11.remaining, 0, '超限后 remaining=0');

// ─── Step 14: generateApiKey 默认 scopes ─────────────────────────────────────
section('Step 14: generateApiKey 默认参数');

const defaultKey = await generateApiKey({ tenantId });
assert(defaultKey.key.startsWith('cue_'), 'key 正确生成');
assert(Array.isArray(defaultKey.scopes), 'scopes 有默认值');
assert(defaultKey.scopes.includes('read'), '默认含 read scope');
assert(defaultKey.scopes.includes('write'), '默认含 write scope');
assertEq(defaultKey.rateLimit, 100, '默认 rateLimit = 100');

// ─── Step 15: 多租户 key 隔离 ────────────────────────────────────────────────
section('Step 15: 多租户 key 不互通');

const t2Key = await generateApiKey({ tenantId: tenantId2, name: 'tenant2-key' });

// tenantId2 的 key 可以被 tenantId2 listApiKeys 看到
const t2Keys = listApiKeys({ tenantId: tenantId2 });
assert(t2Keys.some(k => k.key_prefix === t2Key.keyPrefix || k.keyPrefix === t2Key.keyPrefix), 'tenant2 看到自己的 key');

// tenantId 的 listApiKeys 看不到 tenantId2 的 key
const t1Keys = listApiKeys({ tenantId });
assert(!t1Keys.some(k => k.keyPrefix === t2Key.keyPrefix), 'tenant1 看不到 tenant2 的 key');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
console.log('  W16 公开 API 网关 测试');
if (failed === 0) {
  console.log(`  \x1b[32m✓ ${passed} passed\x1b[0m  `);
} else {
  console.log(`  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m`);
}
console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m\n');

process.exit(failed > 0 ? 1 : 0);
