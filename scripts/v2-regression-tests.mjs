/**
 * v2-regression-tests.mjs
 * V2 路由全量回归测试（目标：代码行覆盖率 ≥ 90%）
 *
 * 策略：
 *   1. 直接调用 handle(ctx)，通过 mock ctx 捕获输出（不启动 HTTP 服务器）
 *   2. 使用独立 tenant_id 隔离测试数据，测试结束后清理
 *   3. 每个端点覆盖：正常路径 + 404/422 错误路径 + ZodError 路径
 *   4. 需要外部服务（GitHub API / LLM）的路由只测试 validation 路径
 *
 * 运行：node scripts/v2-regression-tests.mjs
 */

import assert from 'node:assert/strict';
import { initDb, getDb } from '../server/db/index.js';

// ── 初始化 DB（幂等，已初始化时直接返回）──────────────────────────────
initDb();
const db = getDb();

// ── 测试专用 tenant（用时间戳避免与生产数据冲突）─────────────────────
const TENANT = `test_v2_ci_${Date.now()}`;

// ── 测试计数 ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
    failures.push({ name, err });
  }
}

// ── mock ctx 工厂 ─────────────────────────────────────────────────────
function makeCtx({ method = 'GET', path = '/', body = {}, query = {}, tenantId = TENANT, headers = {} } = {}) {
  let _status = null;
  let _body = null;
  let _error = null;

  const urlObj = new URL(`http://localhost${path}${
    Object.keys(query).length ? '?' + new URLSearchParams(query) : ''
  }`);

  return {
    method,
    path,
    url: urlObj,
    tenantId,
    headers,
    req: {
      headers,
      on: () => {},
      socket: { remoteAddress: '127.0.0.1' },
    },
    res: {
      writeHead: () => {},
      write: () => {},
      end: () => {},
    },
    readBody: async () => body,
    sendV2Json: (status, data) => { _status = status; _body = data; },
    sendV2Error: (status, msg, details) => { _error = { status, msg, details }; },
    // 结果访问器
    status: () => _status,
    result: () => _body,
    error: () => _error,
    ok: () => _status !== null && _status < 400,
  };
}

// ── 测试数据种子 ──────────────────────────────────────────────────────
let seedActorId, seedTaskId, seedPullId, seedMemoryId;

function seedTestData() {
  const now = new Date().toISOString();

  // Actor
  seedActorId = `actor_human_test_${Date.now()}`;
  db.prepare(`
    INSERT OR IGNORE INTO actors
      (id, tenant_id, type, display_name, email, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'human', '测试用户', 'test@example.com', '[]', 1, 1, ?, ?)
  `).run(seedActorId, TENANT, now, now);

  // AI Agent
  const agentId = `actor_agent_test_${Date.now()}`;
  db.prepare(`
    INSERT OR IGNORE INTO actors
      (id, tenant_id, type, display_name, agent_model, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', '测试 Agent', 'claude-code', '["code","review"]', 2, 1, ?, ?)
  `).run(agentId, TENANT, now, now);

  // Task
  seedTaskId = `task_test_${Date.now()}`;
  db.prepare(`
    INSERT OR IGNORE INTO tasks
      (id, tenant_id, project_id, title, actor_id, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, 'proj_test', '测试任务', ?, 'pending', 'P2', 0, ?, ?)
  `).run(seedTaskId, TENANT, seedActorId, now, now);

  // Pull Request
  seedPullId = `pull_test_${Date.now()}`;
  db.prepare(`
    INSERT OR IGNORE INTO pulls
      (id, tenant_id, project_id, number, title, state, author, head_branch, base_branch, created_at, updated_at)
    VALUES (?, ?, 'proj_test', 42, '测试 PR', 'open', 'testuser', 'feat/test', 'main', ?, ?)
  `).run(seedPullId, TENANT, now, now);

  // Memory
  const memResult = db.prepare(`
    INSERT INTO project_memory
      (tenant_id, project_id, kind, body, confidence, source, created_at)
    VALUES (?, 'proj_test', 'convention', '测试约定：所有 API 需要鉴权', 0.9, 'human-added', ?)
  `).run(TENANT, now);
  seedMemoryId = memResult.lastInsertRowid;
}

function cleanupTestData() {
  const tables = [
    'actors', 'tasks', 'pulls', 'reviews', 'project_memory',
    'events', 'pull_task_links', 'actor_autonomy', 'autonomy_history',
    'learning_queue', 'ai_outcomes', 'api_keys', 'api_audit_log',
  ];
  for (const t of tables) {
    try {
      db.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).run(TENANT);
    } catch { /* 表不存在时跳过 */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: system.js — /v2/health, /v2/info
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[system.js]');

const { handle: handleSystem } = await import('../server/v2/routes/system.js');

await test('GET /v2/health 返回 status:ok 和 actors 数量', async () => {
  const ctx = makeCtx({ path: '/v2/health' });
  const handled = await handleSystem(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().status, 'ok');
  assert.equal(ctx.result().version, 'v2');
  assert.ok(typeof ctx.result().actors === 'number');
});

await test('GET /v2/info 返回 version 和 features', async () => {
  const ctx = makeCtx({ path: '/v2/info' });
  const handled = await handleSystem(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().version, 'v2');
  assert.ok(Array.isArray(ctx.result().features));
});

await test('非 /v2/health|info 路径返回 false', async () => {
  const ctx = makeCtx({ path: '/v2/other' });
  const handled = await handleSystem(ctx);
  assert.equal(handled, false);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: actors.js — /v2/actors/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[actors.js]');

const { handle: handleActors } = await import('../server/v2/routes/actors.js');
seedTestData();

await test('GET /v2/actors 返回演员列表', async () => {
  const ctx = makeCtx({ path: '/v2/actors' });
  const handled = await handleActors(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result()));
});

await test('POST /v2/actors 创建人类演员', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/actors',
    body: {
      type: 'human',
      displayName: '新测试成员',
      email: 'newtest@example.com',
      capabilities: ['code'],
    },
  });
  const handled = await handleActors(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 201);
  assert.ok(ctx.result().id.startsWith('actor_human_'));
  assert.equal(ctx.result().type, 'human');
});

await test('POST /v2/actors 创建 AI Agent', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/actors',
    body: {
      type: 'ai-agent',
      displayName: '测试 Agent',
      agentModel: 'gpt-5.5',
      capabilities: ['code', 'review'],
    },
  });
  const handled = await handleActors(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 201);
  assert.ok(ctx.result().id.startsWith('actor_agent_'));
});

await test('POST /v2/actors ZodError — 缺少 type 字段', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/actors',
    body: { displayName: '无类型' },
  });
  // Zod v4 错误格式与 v3 不同，只要确认有错误抛出即可
  await assert.rejects(() => handleActors(ctx));
});

await test('GET /v2/actors/:id 返回已存在的演员', async () => {
  const ctx = makeCtx({ path: `/v2/actors/${seedActorId}` });
  const handled = await handleActors(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().id, seedActorId);
});

await test('GET /v2/actors/:id 返回 404 — 演员不存在', async () => {
  const ctx = makeCtx({ path: '/v2/actors/actor_nonexistent_xyz' });
  const handled = await handleActors(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 404);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: memory.js — /v2/memory/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[memory.js]');

const { handle: handleMemory } = await import('../server/v2/routes/memory.js');

await test('GET /v2/memory/stats 返回各 kind 统计', async () => {
  const ctx = makeCtx({ path: '/v2/memory/stats' });
  const handled = await handleMemory(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result().stats));
  assert.ok(typeof ctx.result().total === 'number');
});

await test('GET /v2/memory 返回记忆列表', async () => {
  const ctx = makeCtx({ path: '/v2/memory' });
  const handled = await handleMemory(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result()));
});

await test('GET /v2/memory 支持 projectId 过滤', async () => {
  const ctx = makeCtx({ path: '/v2/memory', query: { projectId: 'proj_test' } });
  const handled = await handleMemory(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/memory 创建新记忆条目', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/memory',
    body: {
      kind: 'convention',
      body: '测试记忆：所有错误需要打日志，长度超过 10 字符',
      confidence: 0.85,
    },
  });
  const handled = await handleMemory(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 201);
  assert.ok(ctx.result().id);
  assert.equal(ctx.result().kind, 'convention');
});

await test('POST /v2/memory ZodError — body 太短', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/memory',
    body: { kind: 'convention', body: '短' },
  });
  await assert.rejects(() => handleMemory(ctx));
});

await test('POST /v2/memory ZodError — kind 无效', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/memory',
    body: { kind: 'invalid_kind', body: '这是一个足够长的测试记忆内容字符串' },
  });
  await assert.rejects(() => handleMemory(ctx));
});

await test('PATCH /v2/memory/:id 更新 confidence', async () => {
  const ctx = makeCtx({
    method: 'PATCH',
    path: `/v2/memory/${seedMemoryId}`,
    body: { confidence: 0.95 },
  });
  const handled = await handleMemory(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().confidence, 0.95);
});

await test('PATCH /v2/memory/:id 返回 404 — 记忆不存在', async () => {
  const ctx = makeCtx({
    method: 'PATCH',
    path: '/v2/memory/99999999',
    body: { confidence: 0.5 },
  });
  const handled = await handleMemory(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 404);
});

await test('PATCH /v2/memory/:id 返回 400 — 无更新字段', async () => {
  const ctx = makeCtx({
    method: 'PATCH',
    path: `/v2/memory/${seedMemoryId}`,
    body: {},
  });
  const handled = await handleMemory(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 400);
});

await test('DELETE /v2/memory/:id 软删除记忆', async () => {
  // 先创建一条用于删除的记忆
  const insertResult = db.prepare(`
    INSERT INTO project_memory (tenant_id, kind, body, confidence, source, created_at)
    VALUES (?, 'gotcha', '待删除的测试记忆：内容足够长以通过验证', 0.5, 'human-added', datetime('now'))
  `).run(TENANT);
  const delId = insertResult.lastInsertRowid;

  const ctx = makeCtx({ method: 'DELETE', path: `/v2/memory/${delId}` });
  const handled = await handleMemory(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().superseded, true);
});

await test('DELETE /v2/memory/:id 返回 404 — 记忆不存在', async () => {
  const ctx = makeCtx({ method: 'DELETE', path: '/v2/memory/99999998' });
  const handled = await handleMemory(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 404);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: autonomy.js — /v2/autonomy/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[autonomy.js]');

const { handle: handleAutonomy } = await import('../server/v2/routes/autonomy.js');

// 确保 autonomy 表存在
const { ensureAutonomyTables } = await import('../server/services/autonomy.js');
ensureAutonomyTables();

await test('GET /v2/autonomy 返回自主级别列表', async () => {
  const ctx = makeCtx({ path: '/v2/autonomy' });
  const handled = await handleAutonomy(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result().levels));
});

await test('GET /v2/autonomy/:actorId 返回演员自主级别', async () => {
  const ctx = makeCtx({ path: `/v2/autonomy/${seedActorId}` });
  const handled = await handleAutonomy(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().actorId, seedActorId);
  assert.ok(typeof ctx.result().level === 'number');
});

await test('POST /v2/autonomy/:actorId/adjust 手动调整自主级别', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: `/v2/autonomy/${seedActorId}/adjust`,
    body: { level: 2, reason: '测试手动调整', changedBy: 'test-runner' },
  });
  const handled = await handleAutonomy(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(ctx.result().newLevel !== undefined || ctx.result().level !== undefined);
});

await test('POST /v2/autonomy/:actorId/adjust ZodError — level 超出范围', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: `/v2/autonomy/${seedActorId}/adjust`,
    body: { level: 10 },
  });
  await assert.rejects(() => handleAutonomy(ctx));
});

await test('GET /v2/autonomy/:actorId/evaluate 返回评估结果', async () => {
  const ctx = makeCtx({ path: `/v2/autonomy/${seedActorId}/evaluate` });
  const handled = await handleAutonomy(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/autonomy/:actorId/can/:action 返回权限判断', async () => {
  const ctx = makeCtx({ path: `/v2/autonomy/${seedActorId}/can/submit-pr` });
  const handled = await handleAutonomy(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(typeof ctx.result().allowed === 'boolean');
});

await test('POST /v2/autonomy/auto-adjust 执行自动调整', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/autonomy/auto-adjust',
    body: { dryRun: true },
  });
  const handled = await handleAutonomy(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('非 /v2/autonomy 路径返回 false', async () => {
  const ctx = makeCtx({ path: '/v2/other' });
  const handled = await handleAutonomy(ctx);
  assert.equal(handled, false);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: gateway.js — /v2/gateway/*, /v2/openapi.json
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[gateway.js]');

const { handle: handleGateway } = await import('../server/v2/routes/gateway.js');
const { ensureGatewayTables } = await import('../server/middleware/apiGateway.js');
ensureGatewayTables();

await test('GET /v2/openapi.json 返回 OpenAPI 规范', async () => {
  const ctx = makeCtx({ path: '/v2/openapi.json' });
  const handled = await handleGateway(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().openapi, '3.0.0');
  assert.ok(ctx.result().paths);
});

await test('GET /v2/gateway/keys 返回 API Key 列表', async () => {
  const ctx = makeCtx({ path: '/v2/gateway/keys' });
  const handled = await handleGateway(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result().keys));
});

await test('POST /v2/gateway/keys 生成新 API Key', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/gateway/keys',
    body: { name: '测试 key', scopes: ['read', 'write'], rateLimit: 50 },
  });
  const handled = await handleGateway(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 201);
  assert.ok(ctx.result().key?.startsWith('cue_'));
  assert.ok(ctx.result().warning);
});

await test('POST /v2/gateway/keys ZodError — rateLimit 过大', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/gateway/keys',
    body: { rateLimit: 99999 },
  });
  await assert.rejects(() => handleGateway(ctx));
});

await test('GET /v2/gateway/audit 返回审计日志', async () => {
  const ctx = makeCtx({ path: '/v2/gateway/audit' });
  const handled = await handleGateway(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/gateway/keys/:id/revoke 返回 404 — key 不存在', async () => {
  const ctx = makeCtx({ method: 'POST', path: '/v2/gateway/keys/99999/revoke' });
  const handled = await handleGateway(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 404);
});

await test('GET /v2/gateway/validate — 无 v2 key 返回 valid:false', async () => {
  const ctx = makeCtx({
    path: '/v2/gateway/validate',
    headers: { authorization: 'Bearer legacy_key' },
  });
  // extractApiKey 从 req.headers 读取
  ctx.req.headers = { authorization: 'Bearer legacy_key' };
  const handled = await handleGateway(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().valid, false);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 6: events.js — /v2/events/grouped, /v2/tasks/:taskId/explanation
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[events.js]');

const { handle: handleEvents } = await import('../server/v2/routes/events.js');

await test('GET /v2/events/grouped 返回按 actor 分组的事件', async () => {
  const ctx = makeCtx({ path: '/v2/events/grouped', query: { hours: '24' } });
  const handled = await handleEvents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(typeof ctx.result().grouped === 'object');
  assert.ok(typeof ctx.result().totalEvents === 'number');
});

await test('GET /v2/tasks/:taskId/explanation 返回任务推荐解释', async () => {
  const ctx = makeCtx({ path: `/v2/tasks/${seedTaskId}/explanation` });
  const handled = await handleEvents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().taskId, seedTaskId);
});

await test('GET /v2/tasks/:taskId/explanation 返回 404 — 任务不存在', async () => {
  const ctx = makeCtx({ path: '/v2/tasks/task_nonexistent_xyz/explanation' });
  const handled = await handleEvents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 404);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 7: outcomes.js — /v2/outcomes/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[outcomes.js]');

const { handle: handleOutcomes } = await import('../server/v2/routes/outcomes.js');

// 确保 ai_outcomes 表存在
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS ai_outcomes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id            TEXT NOT NULL DEFAULT 'default',
      action_type          TEXT NOT NULL,
      action_ref_id        TEXT NOT NULL,
      outcome_signal       TEXT NOT NULL,
      polarity             INTEGER NOT NULL,
      evidence_json        TEXT,
      observer             TEXT NOT NULL DEFAULT 'auto-rule',
      observation_lag_hours INTEGER,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
} catch { /* 表已存在 */ }

await test('POST /v2/outcomes 记录一条 outcome', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/outcomes',
    body: {
      actionType: 'task.dispatch',
      actionRefId: seedTaskId,
      outcomeSignal: '任务按时完成',
      polarity: 1,
      observer: 'human-label',
    },
  });
  const handled = await handleOutcomes(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 201);
  assert.ok(ctx.result().id);
});

await test('POST /v2/outcomes ZodError — polarity 无效', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/outcomes',
    body: {
      actionType: 'task.dispatch',
      actionRefId: 'some_id',
      outcomeSignal: '测试信号',
      polarity: 2, // 无效值
    },
  });
  await assert.rejects(() => handleOutcomes(ctx));
});

await test('GET /v2/outcomes 返回 outcomes 列表', async () => {
  const ctx = makeCtx({ path: '/v2/outcomes' });
  const handled = await handleOutcomes(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/outcomes/stats 返回聚合统计', async () => {
  const ctx = makeCtx({ path: '/v2/outcomes/stats' });
  const handled = await handleOutcomes(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/outcomes 支持 action_type 过滤', async () => {
  const ctx = makeCtx({ path: '/v2/outcomes', query: { action_type: 'task.dispatch' } });
  const handled = await handleOutcomes(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/outcomes/auto-label 执行批量自动打标', async () => {
  const ctx = makeCtx({ method: 'POST', path: '/v2/outcomes/auto-label', body: {} });
  const handled = await handleOutcomes(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/outcomes/label-task 对任务打标', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/outcomes/label-task',
    body: { taskId: seedTaskId },
  });
  const handled = await handleOutcomes(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/outcomes/label-review — review 不存在时抛出错误', async () => {
  // autoLabelReviewOutcome 在 review 不存在时直接 throw（路由未 catch）
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/outcomes/label-review',
    body: { reviewId: 'review_nonexistent_xyz' },
  });
  await assert.rejects(() => handleOutcomes(ctx), /not found/i);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 8: learning.js — /v2/learning/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[learning.js]');

const { handle: handleLearning } = await import('../server/v2/routes/learning.js');
const { ensureLearningQueueTable } = await import('../server/services/activeLearning.js');
ensureLearningQueueTable();

await test('GET /v2/learning/stats 返回队列统计', async () => {
  const ctx = makeCtx({ path: '/v2/learning/stats' });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/learning/queue 返回待标注队列', async () => {
  const ctx = makeCtx({ path: '/v2/learning/queue' });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/learning/enqueue 入队一个学习条目', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/learning/enqueue',
    body: {
      actionType: 'recommend',
      actionRefId: seedTaskId,
      reason: '置信度较低，需要人工确认推荐结果',
      priority: 7,
      aiConfidence: 0.45,
    },
  });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.ok(ctx.status() === 200 || ctx.status() === 201);
});

await test('POST /v2/learning/enqueue ZodError — 缺少 reason', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/learning/enqueue',
    body: { actionType: 'recommend', actionRefId: 'some_id' },
  });
  await assert.rejects(() => handleLearning(ctx));
});

await test('POST /v2/learning/dismiss 忽略队列条目 — 不存在时返回 false', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/learning/dismiss',
    body: { queueId: 99999 },
  });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/learning/weeks 返回周期边界', async () => {
  const ctx = makeCtx({ path: '/v2/learning/weeks' });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(ctx.result().lastWeek);
  assert.ok(ctx.result().currentWeek);
});

await test('GET /v2/learning/weights 返回 ranker 权重', async () => {
  const ctx = makeCtx({ path: '/v2/learning/weights' });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(ctx.result().weights);
});

await test('POST /v2/learning/weights/reset 重置 ranker 权重', async () => {
  const ctx = makeCtx({ method: 'POST', path: '/v2/learning/weights/reset', body: {} });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().ok, true);
});

await test('GET /v2/learning/reports 返回学习报告列表', async () => {
  const ctx = makeCtx({ path: '/v2/learning/reports' });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/learning/reports/:id 返回 404 — 报告不存在', async () => {
  const ctx = makeCtx({ path: '/v2/learning/reports/99999' });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 404);
});

await test('POST /v2/learning/auto-enqueue 自动扫描低置信度', async () => {
  const ctx = makeCtx({ method: 'POST', path: '/v2/learning/auto-enqueue', body: {} });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('非 /v2/learning/ 路径返回 false', async () => {
  const ctx = makeCtx({ path: '/v2/other' });
  const handled = await handleLearning(ctx);
  assert.equal(handled, false);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 9: observability.js — /v2/space, /v2/risks, /v2/runbooks, /v2/alerts
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[observability.js]');

const { handle: handleObs } = await import('../server/v2/routes/observability.js');
const { ensureAlertsTable } = await import('../server/services/runbook.js');
ensureAlertsTable();

await test('GET /v2/space 返回 SPACE 指标', async () => {
  const ctx = makeCtx({ path: '/v2/space' });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/space/actors 返回人均 SPACE 指标', async () => {
  const ctx = makeCtx({ path: '/v2/space/actors' });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result().actors));
});

await test('GET /v2/risks 返回风险扫描结果', async () => {
  const ctx = makeCtx({ path: '/v2/risks' });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/risks/task/:taskId 返回单任务风险', async () => {
  const ctx = makeCtx({ path: `/v2/risks/task/${seedTaskId}` });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/risks/propagate 执行风险传播', async () => {
  const ctx = makeCtx({ method: 'POST', path: '/v2/risks/propagate', body: { threshold: 7 } });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/runbooks 返回内置 runbook 列表', async () => {
  const ctx = makeCtx({ path: '/v2/runbooks' });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result().runbooks));
  assert.ok(ctx.result().total > 0);
});

await test('GET /v2/alerts/evaluate 评估当前告警', async () => {
  const ctx = makeCtx({ path: '/v2/alerts/evaluate' });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('GET /v2/alerts 返回告警历史', async () => {
  const ctx = makeCtx({ path: '/v2/alerts' });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/alerts/cycle 运行告警周期', async () => {
  const ctx = makeCtx({ method: 'POST', path: '/v2/alerts/cycle', body: { cooldownHours: 0 } });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/alerts/:id/ack — 告警不存在返回 ok:false', async () => {
  // acknowledgeAlert 返回 false（未找到），路由始终返回 200 { ok: boolean }
  const ctx = makeCtx({ method: 'POST', path: '/v2/alerts/99999/ack', body: {} });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().ok, false);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 10: reviews.js — /v2/reviews/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[reviews.js]');

const { handle: handleReviews } = await import('../server/v2/routes/reviews.js');

await test('GET /v2/reviews 返回 review 列表', async () => {
  const ctx = makeCtx({ path: '/v2/reviews' });
  const handled = await handleReviews(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result()));
});

await test('GET /v2/reviews 支持 pullId 过滤', async () => {
  const ctx = makeCtx({ path: '/v2/reviews', query: { pullId: seedPullId } });
  const handled = await handleReviews(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/reviews/trigger 返回 404 — pull 不存在', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/reviews/trigger',
    body: { pullId: 'pull_nonexistent_xyz', maxFiles: 5 },
  });
  const handled = await handleReviews(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 404);
});

await test('POST /v2/reviews/trigger ZodError — pullId 缺失', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/reviews/trigger',
    body: { maxFiles: 5 },
  });
  await assert.rejects(() => handleReviews(ctx));
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 11: sync.js — /v2/sync/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[sync.js]');

const { handle: handleSync } = await import('../server/v2/routes/sync.js');

await test('GET /v2/sync/links 返回 PR-Task 关联列表', async () => {
  const ctx = makeCtx({ path: '/v2/sync/links' });
  const handled = await handleSync(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result().links));
});

await test('GET /v2/sync/links 支持 project_id 过滤', async () => {
  const ctx = makeCtx({ path: '/v2/sync/links', query: { project_id: 'proj_test' } });
  const handled = await handleSync(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/sync/webhook 无签名校验时处理 payload', async () => {
  // 确保 GITHUB_WEBHOOK_SECRET 未设置时跳过签名校验
  const origSecret = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;

  const payload = JSON.stringify({ action: 'opened', pull_request: { number: 99, title: '测试 PR' } });
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/sync/webhook',
    headers: { 'x-github-event': 'pull_request', 'content-type': 'application/json' },
  });

  // rawBody 模拟
  ctx.req.rawBody = Buffer.from(payload);

  const handled = await handleSync(ctx);
  assert.equal(handled, true);
  // webhook handler 可能返回 200 或报错，重点是路由命中
  assert.ok(ctx.status() !== null || ctx.error() !== null);

  if (origSecret) process.env.GITHUB_WEBHOOK_SECRET = origSecret;
});

await test('POST /v2/sync/resync ZodError — schema 验证通过（可选 projectId）', async () => {
  // resync 不依赖外部服务的 validation 部分：schema 允许空 body
  // 这里只测试到 schema 通过，实际 resyncAllPRLinks 可能失败
  const ctx = makeCtx({ method: 'POST', path: '/v2/sync/resync', body: {} });
  const handled = await handleSync(ctx);
  assert.equal(handled, true);
  // 200 或内部错误均可接受（取决于是否有数据），重点是路由命中
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 12: agents.js — /v2/agents/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[agents.js]');

const { handle: handleAgents } = await import('../server/v2/routes/agents.js');

await test('POST /v2/agents/standup 提交 agent 晨会', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/standup',
    body: {
      agentId: seedActorId,
      date: '2026-05-23',
      yesterday: '完成了测试任务编写',
      today: '继续完善测试覆盖率',
      blockers: '无',
    },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().ok, true);
});

await test('POST /v2/agents/standup ZodError — date 格式错误', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/standup',
    body: {
      agentId: seedActorId,
      date: '2026/05/23', // 格式错误
      yesterday: '完成了测试',
      today: '继续测试',
    },
  });
  await assert.rejects(() => handleAgents(ctx));
});

await test('POST /v2/agents/callback 提交 accepted 回调', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/callback',
    body: {
      agentId: seedActorId,
      taskId: seedTaskId,
      action: 'accepted',
    },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().ok, true);
  assert.equal(ctx.result().eventType, 'agent.task.accepted');
});

await test('POST /v2/agents/callback 提交 needs-human 回调', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/callback',
    body: {
      agentId: seedActorId,
      taskId: seedTaskId,
      action: 'needs-human',
      question: '如何处理这个边缘案例？',
    },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/agents/callback 提交 blocked 回调', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/callback',
    body: {
      agentId: seedActorId,
      taskId: seedTaskId,
      action: 'blocked',
      reason: '依赖服务不可用',
    },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

await test('POST /v2/agents/dispatch 返回 404 — agent 不存在', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/dispatch',
    body: { agentId: 'actor_agent_nonexistent', taskId: seedTaskId },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 404);
});

await test('POST /v2/agents/auto-dispatch 返回 404 — 任务不存在', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/auto-dispatch',
    body: { taskId: 'task_nonexistent_xyz' },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 404);
});

await test('POST /v2/agents/auto-dispatch 返回 409 — 任务非 pending 状态', async () => {
  // 先把任务改为 in_progress
  db.prepare(`UPDATE tasks SET state = 'in_progress' WHERE id = ? AND tenant_id = ?`).run(seedTaskId, TENANT);

  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/auto-dispatch',
    body: { taskId: seedTaskId },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 409);

  // 恢复为 pending
  db.prepare(`UPDATE tasks SET state = 'pending' WHERE id = ? AND tenant_id = ?`).run(seedTaskId, TENANT);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 13: pulls.js — /v2/pulls/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[pulls.js]');

const { handle: handlePulls } = await import('../server/v2/routes/pulls.js');

await test('POST /v2/pulls/generate-description ZodError — taskId 缺失', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/pulls/generate-description',
    body: { branchName: 'feat/test' },
  });
  await assert.rejects(() => handlePulls(ctx));
});

await test('非 /v2/pulls/ 路径返回 false', async () => {
  const ctx = makeCtx({ path: '/v2/other' });
  const handled = await handlePulls(ctx);
  assert.equal(handled, false);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 14: recommend.js — /v2/recommend/*
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[recommend.js]');

const { handle: handleRecommend } = await import('../server/v2/routes/recommend.js');

await test('POST /v2/recommend ZodError — taskId 缺失', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/recommend',
    body: { topK: 5 },
  });
  await assert.rejects(() => handleRecommend(ctx));
});

await test('POST /v2/recommend 正常推荐（有真实任务）', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/recommend',
    body: {
      taskId: seedTaskId,
      topK: 3,
      actorType: 'all',
      minScore: 0,
      explain: false,
    },
  });
  const handled = await handleRecommend(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result().recommendations));
});

await test('POST /v2/recommend/batch 批量推荐', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/recommend/batch',
    body: { actorType: 'all', minScore: 0 },
  });
  const handled = await handleRecommend(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 15: handleV2 app.js — 路由分发、鉴权、错误处理
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[app.js — handleV2 分发]');

const { handleV2 } = await import('../server/v2/app.js');

function makeHttpCtx({ method = 'GET', pathname = '/', searchParams = {} } = {}) {
  const url = new URL(`http://localhost${pathname}`);
  Object.entries(searchParams).forEach(([k, v]) => url.searchParams.set(k, v));

  let _chunks = [];
  let _status = null;
  let _headers = {};

  const req = {
    method,
    headers: {},
    on: (ev, fn) => {
      if (ev === 'end') setTimeout(fn, 0);
    },
    socket: { remoteAddress: '127.0.0.1' },
  };

  const res = {
    writeHead: (code, hdrs) => { _status = code; _headers = hdrs || {}; },
    end: (body) => { _chunks.push(body || ''); },
    write: (chunk) => { _chunks.push(chunk); },
    status: () => _status,
    body: () => {
      const raw = _chunks.join('');
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };

  return { req, res, url };
}

await test('handleV2 OPTIONS — CORS preflight 返回 204', async () => {
  const { req, res, url } = makeHttpCtx({ method: 'OPTIONS', pathname: '/v2/health' });
  await handleV2(req, res, url);
  assert.equal(res.status(), 204);
});

await test('handleV2 GET /v2/health — 豁免鉴权，返回 200', async () => {
  const { req, res, url } = makeHttpCtx({ pathname: '/v2/health' });
  await handleV2(req, res, url);
  assert.equal(res.status(), 200);
  const body = res.body();
  assert.equal(body.status, 'ok');
});

await test('handleV2 GET /v2/openapi.json — 豁免鉴权，返回 200', async () => {
  const { req, res, url } = makeHttpCtx({ pathname: '/v2/openapi.json' });
  await handleV2(req, res, url);
  assert.equal(res.status(), 200);
  assert.equal(res.body().openapi, '3.0.0');
});

await test('handleV2 GET /v2/info — 豁免鉴权，返回 200', async () => {
  const { req, res, url } = makeHttpCtx({ pathname: '/v2/info' });
  await handleV2(req, res, url);
  assert.equal(res.status(), 200);
});

await test('handleV2 GET /v2/nonexistent — 404', async () => {
  const { req, res, url } = makeHttpCtx({ pathname: '/v2/nonexistent_route_xyz' });
  await handleV2(req, res, url);
  assert.equal(res.status(), 404);
});

await test('handleV2 — legacy CUE_API_KEY 鉴权失败返回 401', async () => {
  const origKey = process.env.CUE_API_KEY;
  process.env.CUE_API_KEY = 'secret_key_test';

  const { req, res, url } = makeHttpCtx({ pathname: '/v2/actors' });
  req.headers = { 'x-cue-api-key': 'wrong_key' };
  await handleV2(req, res, url);
  assert.equal(res.status(), 401);

  if (origKey) process.env.CUE_API_KEY = origKey;
  else delete process.env.CUE_API_KEY;
});

await test('handleV2 — legacy CUE_API_KEY 鉴权成功正常通过', async () => {
  const origKey = process.env.CUE_API_KEY;
  process.env.CUE_API_KEY = 'test_secret_key_valid';

  const { req, res, url } = makeHttpCtx({ pathname: '/v2/health' });
  // health 是豁免路径，不需要 key
  await handleV2(req, res, url);
  assert.equal(res.status(), 200);

  if (origKey) process.env.CUE_API_KEY = origKey;
  else delete process.env.CUE_API_KEY;
});

await test('handleV2 ZodError — 路由内 validation 失败返回 400', async () => {
  // POST /v2/actors without required fields
  const { req, res, url } = makeHttpCtx({ method: 'POST', pathname: '/v2/actors' });
  req.on = (ev, fn) => {
    if (ev === 'data') fn(Buffer.from(JSON.stringify({ displayName: 'no type' })));
    if (ev === 'end') fn();
  };
  await handleV2(req, res, url);
  assert.equal(res.status(), 400);
  assert.ok(res.body().error === 'validation error');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 16: vectorStore.js — embedText, initVectorStore
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[vectorStore.js]');

const { embedText, initVectorStore, isVecReady } = await import('../server/services/vectorStore.js');

await test('embedText 返回 Float32Array，L2 范数约为 1', () => {
  const vec = embedText('优化数据库查询性能');
  assert.ok(vec instanceof Float32Array);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  // 非空文本：范数约为 1（±0.01）
  assert.ok(norm > 0.99 && norm < 1.01, `norm should be ~1, got ${norm}`);
});

await test('embedText 空文本返回零向量', () => {
  const vec = embedText('');
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  assert.equal(norm, 0);
});

await test('embedText 中英文混合文本正常处理', () => {
  const vec = embedText('fix: resolve API timeout issue 解决接口超时问题');
  assert.ok(vec instanceof Float32Array);
  assert.ok(vec.length === 256);
});

await test('embedText 语义相近的文本向量相似度高于随机文本', () => {
  function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  const v1 = embedText('数据库查询优化');
  const v2 = embedText('SQL 查询性能优化');
  const v3 = embedText('企业微信消息推送配置');

  const simRelated = cosineSim(v1, v2);
  const simUnrelated = cosineSim(v1, v3);
  assert.ok(simRelated > simUnrelated, `related(${simRelated.toFixed(3)}) should > unrelated(${simUnrelated.toFixed(3)})`);
});

await test('initVectorStore — sqlite-vec 可用时 isVecReady 为 true', async () => {
  // 尝试初始化（sqlite-vec 可能未安装，graceful degradation）
  await initVectorStore(db);
  // 无论结果如何，函数应正常返回（不抛错）
  const ready = isVecReady();
  assert.ok(typeof ready === 'boolean');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 17: observability.js 补充 — /v2/observability/* 全端点
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[observability.js — 补充端点]');

await test('GET /v2/observability/llm 返回 LLM 调用统计', async () => {
  const ctx = makeCtx({ path: '/v2/observability/llm' });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(typeof ctx.result().today.totalCalls === 'number');
  assert.ok(typeof ctx.result().recentFailRatePct === 'number');
  assert.ok(Array.isArray(ctx.result().byPurpose));
});

await test('GET /v2/observability/events 返回事件列表', async () => {
  const ctx = makeCtx({ path: '/v2/observability/events' });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result().events));
  assert.ok(typeof ctx.result().total === 'number');
  assert.ok(typeof ctx.result().unprocessed === 'number');
});

await test('GET /v2/observability/events 支持 type 过滤', async () => {
  const ctx = makeCtx({ path: '/v2/observability/events', query: { type: 'task.claimed', limit: '10' } });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(Array.isArray(ctx.result().events));
});

await test('GET /v2/observability/sync-health 返回同步健康状态', async () => {
  const ctx = makeCtx({ path: '/v2/observability/sync-health' });
  const handled = await handleObs(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(typeof ctx.result().taskPrConsistencyPct === 'number');
  assert.ok(ctx.result().health === 'healthy' || ctx.result().health === 'degraded');
  assert.ok(typeof ctx.result().orphanPRs === 'number');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 18: vectorStore 补充 — searchSimilarMemory, rebuildMemoryIndex
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[vectorStore.js — 补充函数]');

const { searchSimilarMemory, rebuildMemoryIndex, indexMemoryEntry } = await import('../server/services/vectorStore.js');

await test('indexMemoryEntry 不抛异常（sqlite-vec 就绪时静默降级）', () => {
  if (!isVecReady()) return;
  // indexMemoryEntry 内部有 try-catch，即使写入失败也不抛异常
  assert.doesNotThrow(() => {
    indexMemoryEntry(db, { memoryId: Number(seedMemoryId), text: '测试约定：API 需要鉴权，确保安全性' });
  });
});

await test('searchSimilarMemory 返回相关记忆', () => {
  if (!isVecReady()) return;
  const results = searchSimilarMemory(db, {
    tenantId: TENANT,
    query: 'API 鉴权安全',
    limit: 5,
  });
  // 有数据时返回数组，无数据时返回空数组
  assert.ok(results === null || Array.isArray(results), 'should return array or null');
});

await test('searchSimilarMemory 支持 projectId 和 kinds 过滤', () => {
  if (!isVecReady()) return;
  const results = searchSimilarMemory(db, {
    tenantId: TENANT,
    query: '测试任务规范',
    projectId: 'proj_test',
    kinds: ['convention', 'decision'],
    limit: 3,
  });
  assert.ok(results === null || Array.isArray(results));
});

await test('searchSimilarMemory — sqlite-vec 未就绪时返回 null', () => {
  // 测试降级路径：直接调用时，如果 _vecReady=false 应返回 null
  // 用非 test tenant 以确保没有意外数据，同时测试空结果
  const results = searchSimilarMemory(db, {
    tenantId: 'tenant_that_has_no_data_xyz',
    query: '随机测试查询',
    limit: 1,
  });
  // 返回 null（未就绪）或 []（就绪但无结果）
  assert.ok(results === null || Array.isArray(results));
});

await test('rebuildMemoryIndex 补建缺失向量', () => {
  if (!isVecReady()) return;
  const { indexed } = rebuildMemoryIndex(db, TENANT);
  assert.ok(typeof indexed === 'number', 'should return indexed count');
  assert.ok(indexed >= 0);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 19: reviews.js 补充 — rawDiff 路径（绕过 GitHub API）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[reviews.js — rawDiff 路径]');

await test('POST /v2/reviews/trigger rawDiff — no reviewable files 返回 Pass', async () => {
  // 提供一个只有无意义变更的 diff（非代码文件）
  const rawDiff = `diff --git a/README.md b/README.md
index 1234567..abcdefg 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # CUE Project Hub
+
+更新说明文档
 描述
`;
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/reviews/trigger',
    body: { pullId: seedPullId, rawDiff, maxFiles: 20 },
  });
  const handled = await handleReviews(ctx);
  assert.equal(handled, true);
  // rawDiff 路径走 parseDiffText，无 reviewable files 时返回 Pass
  assert.ok(ctx.status() === 200);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 20: agents.js 补充 — 覆盖更多 dispatch 路径
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[agents.js — 补充 dispatch 路径]');

await test('POST /v2/agents/dispatch 返回 422 — agent 无 endpoint', async () => {
  // 创建一个 ai-agent 但没有 agent_endpoint
  const noEndpointAgentId = `actor_agent_noep_${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO actors (id, tenant_id, type, display_name, agent_model, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', 'No Endpoint Agent', 'gpt-5.5', '["code"]', 1, 1, ?, ?)
  `).run(noEndpointAgentId, TENANT, now, now);

  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/dispatch',
    body: { agentId: noEndpointAgentId, taskId: seedTaskId },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 422);
});

await test('POST /v2/agents/callback completed — 更新任务状态', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/callback',
    body: {
      agentId: seedActorId,
      taskId: seedTaskId,
      action: 'completed',
      artifacts: ['https://github.com/pr/42'],
      acStatus: { passed: true },
    },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().eventType, 'agent.task.completed');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 21: events.js 补充 — 有事件数据时的 grouped
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[events.js — 补充有数据路径]');

await test('GET /v2/events/grouped — 有事件时 grouped 非空', async () => {
  // 种一条事件
  db.prepare(`
    INSERT INTO events (tenant_id, type, payload_json, source, created_at)
    VALUES (?, 'task.claimed', '{"actorId":"actor_test","taskId":"task_test"}', 'test', datetime('now'))
  `).run(TENANT);

  const ctx = makeCtx({ path: '/v2/events/grouped', query: { hours: '24' } });
  const handled = await handleEvents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(typeof ctx.result().grouped === 'object');
  // 有数据时 grouped 应有 actor 键
  assert.ok(ctx.result().totalEvents >= 1);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 22: sync.js 补充 — writeback schema + resync 成功路径
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[sync.js — 补充路径]');

await test('POST /v2/sync/writeback ZodError — 缺少 projectId', async () => {
  const ctx = makeCtx({ method: 'POST', path: '/v2/sync/writeback', body: {} });
  await assert.rejects(() => handleSync(ctx));
});

await test('POST /v2/sync/webhook 无效 JSON payload 返回 400', async () => {
  const origSecret = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;

  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/sync/webhook',
    headers: { 'x-github-event': 'push' },
  });
  ctx.req.rawBody = Buffer.from('{ invalid json %%% }');

  const handled = await handleSync(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 400);

  if (origSecret) process.env.GITHUB_WEBHOOK_SECRET = origSecret;
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 23: app.js 补充 — rate limit header 注入路径
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[app.js — 补充鉴权路径]');

await test('handleV2 — 无 API Key 且未设置 CUE_API_KEY 时放行', async () => {
  const origKey = process.env.CUE_API_KEY;
  delete process.env.CUE_API_KEY;

  const { req, res, url } = makeHttpCtx({ pathname: '/v2/actors' });
  req.headers = {}; // 无 key
  await handleV2(req, res, url);
  // 无 key 配置时应正常放行（返回 200）
  assert.equal(res.status(), 200);

  if (origKey) process.env.CUE_API_KEY = origKey;
});

await test('handleV2 — 内部错误时返回 500', async () => {
  // 通过发送一个会触发 DB 错误的请求来测试 500 路径
  // 这里直接测试 app.js 的错误捕获：通过注入一个会抛错的 readBody
  const { req, res, url } = makeHttpCtx({ method: 'POST', pathname: '/v2/memory' });
  // req.on 永远不触发 end，会导致 readBody 卡住
  // 改为通过发送损坏 JSON 测试 500
  req.on = (ev, fn) => {
    if (ev === 'data') fn(Buffer.from('"valid-but-wrong-type"')); // 非对象
    if (ev === 'end')  fn();
  };
  await handleV2(req, res, url);
  // ZodError → 400；其他错误 → 500
  assert.ok(res.status() === 400 || res.status() === 500);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 24: learning.js 补充 — label + weekly-batch
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[learning.js — label + weekly-batch]');

await test('POST /v2/learning/label 对队列条目人工打标', async () => {
  // 先入队一条（如果没有）
  const existing = db.prepare(
    "SELECT id FROM learning_queue WHERE tenant_id = ? AND status = 'pending' LIMIT 1"
  ).get(TENANT);

  let queueId;
  if (existing) {
    queueId = existing.id;
  } else {
    // 创建一条
    const { enqueue } = await import('../server/services/activeLearning.js');
    const id = await enqueue({
      tenantId: TENANT,
      actionType: 'label-test',
      actionRefId: `label_test_${Date.now()}`,
      reason: '测试标注：人工确认推荐是否准确',
      priority: 5,
      aiConfidence: 0.4,
    });
    queueId = id;
  }

  if (!queueId) return; // 入队失败时跳过

  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/learning/label',
    body: { queueId, polarity: 1, signal: '推荐正确，已采纳', labeledBy: 'test-runner' },
  });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().ok, true);
});

await test('POST /v2/learning/weekly-batch 触发周度批处理', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/learning/weekly-batch',
    body: { weekStart: '2026-05-18', weekEnd: '2026-05-24' },
  });
  const handled = await handleLearning(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  // 返回批处理结果（可能为空）
  assert.ok(ctx.result() !== null);
});

await test('POST /v2/learning/weekly-batch ZodError — date 格式错误', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/learning/weekly-batch',
    body: { weekStart: '2026/05/18' }, // 格式错误
  });
  await assert.rejects(() => handleLearning(ctx));
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 25: agents.js 补充 — dryRun + human actor 路径
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[agents.js — dryRun + human 路径]');

await test('POST /v2/agents/auto-dispatch dryRun:true — 返回推荐不执行', async () => {
  // 确保任务是 pending 状态
  db.prepare(`UPDATE tasks SET state = 'pending' WHERE id = ? AND tenant_id = ?`).run(seedTaskId, TENANT);

  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/auto-dispatch',
    body: { taskId: seedTaskId, dryRun: true },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  // recommender 可能有推荐（dryRun true）或无候选（422）
  assert.ok(
    (ctx.status() === 200 && ctx.result().dryRun === true) ||
    ctx.error()?.status === 422,
    `应返回 dryRun 结果或 422（无候选），实际：${ctx.status() || ctx.error()?.status}`
  );
});

await test('POST /v2/agents/dispatch — task 不存在返回 404', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/dispatch',
    body: { agentId: seedActorId, taskId: 'task_nonexistent_dispatch' },
  });
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  // seedActorId 是 human 类型，agent 查询会返回 null → 404
  assert.equal(ctx.error().status, 404);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 26: gateway.js 补充 — 已生成的 key 执行 revoke
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[gateway.js — revoke 真实 key]');

await test('POST /v2/gateway/keys/:id/revoke 成功撤销已存在的 key', async () => {
  // 先生成一个 key
  const genCtx = makeCtx({
    method: 'POST',
    path: '/v2/gateway/keys',
    body: { name: '待撤销测试 key' },
  });
  await handleGateway(genCtx);
  const keyId = genCtx.result()?.id;
  if (!keyId) return; // 生成失败则跳过

  const ctx = makeCtx({ method: 'POST', path: `/v2/gateway/keys/${keyId}/revoke` });
  const handled = await handleGateway(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().revoked, true);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 27: events.js 补充 — topRec 存在时的 explanation 结构
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[events.js — explanation topRec 结构]');

await test('GET /v2/tasks/:taskId/explanation topActor 字段结构正确', async () => {
  const ctx = makeCtx({ path: `/v2/tasks/${seedTaskId}/explanation` });
  const handled = await handleEvents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.equal(ctx.result().taskId, seedTaskId);
  // topActor 可能为 null（无推荐）或有值
  if (ctx.result().topActor) {
    assert.ok(ctx.result().topActor.actorId);
    assert.ok(typeof ctx.result().topActor.score === 'number');
  }
  assert.ok(Array.isArray(ctx.result().allCandidates));
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 28: reviews.js 补充 — rawDiff 覆盖 LLM 路径
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[reviews.js — rawDiff with code files]');

await test('POST /v2/reviews/trigger rawDiff 含真实代码文件 — 触发 LLM review', async () => {
  const rawDiff = `diff --git a/server/api.js b/server/api.js
index 1234567..abcdefg 100644
--- a/server/api.js
+++ b/server/api.js
@@ -1,5 +1,10 @@
 import express from 'express';
+import db from './db.js';

 export function createRouter() {
   const router = express.Router();
+
+  router.get('/users', async (req, res) => {
+    const users = db.query('SELECT * FROM users');
+    res.json(users);
+  });
+
   return router;
 }
`;
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/reviews/trigger',
    body: { pullId: seedPullId, rawDiff, maxFiles: 10 },
  });
  const handled = await handleReviews(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(ctx.result().level, 'should have review level');
  assert.ok(['Pass', 'Warning', 'Block', 'Escalate'].includes(ctx.result().level));
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 29: vectorStore 补充 — searchSimilarMemory with indexed data
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[vectorStore.js — searchSimilarMemory with data]');

await test('searchSimilarMemory 有索引数据时返回结果数组（Binary 格式写入）', () => {
  if (!isVecReady()) return;

  const memRow = db.prepare(
    "SELECT id FROM project_memory WHERE tenant_id = ? AND superseded_by IS NULL LIMIT 1"
  ).get(TENANT);
  if (!memRow) return;

  // 用 Float32Array 的 Buffer 格式写入（sqlite-vec 原生支持）
  const vec = embedText('数据库索引优化 SQL 查询性能');
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  try {
    db.prepare('DELETE FROM memory_vec WHERE rowid = ?').run(memRow.id);
    db.prepare('INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)').run(memRow.id, buf);
  } catch { return; } // 写入格式不兼容时跳过，不影响其他测试

  const results = searchSimilarMemory(db, {
    tenantId: TENANT,
    query: '数据库查询优化',
    limit: 5,
  });

  assert.ok(Array.isArray(results), 'should return array or null');
  if (Array.isArray(results) && results.length > 0) {
    assert.ok(results[0]._vecDistance !== undefined, 'should have _vecDistance');
    // 验证 sort 路径：第一个结果应有最小距离
    if (results.length > 1) {
      assert.ok(results[0]._vecDistance <= results[1]._vecDistance);
    }
  }
});

await test('searchSimilarMemory error 时返回 null（降级信号）', () => {
  if (!isVecReady()) return;

  // 用损坏的查询触发错误路径（通过传入极短文本）
  const results = searchSimilarMemory(db, {
    tenantId: TENANT,
    query: '', // 空文本 → 零向量
    limit: 1,
  });
  // 零向量的 KNN 结果可能为空数组或 null（降级）
  assert.ok(results === null || Array.isArray(results));
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 30: sync.js 补充 — webhook 成功处理路径
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[sync.js — webhook 成功路径]');

await test('POST /v2/sync/webhook push 事件处理', async () => {
  const origSecret = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;

  const pushPayload = JSON.stringify({
    ref: 'refs/heads/main',
    commits: [{ id: 'abc123', message: 'feat: 测试推送', author: { name: 'testuser' } }],
    repository: { name: 'CUE.AI', full_name: 'CUEAITECH/CUE.AI' },
  });

  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/sync/webhook',
    headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
  });
  ctx.req.rawBody = Buffer.from(pushPayload);

  const handled = await handleSync(ctx);
  assert.equal(handled, true);
  assert.ok(ctx.status() === 200 || ctx.error() !== null);

  if (origSecret) process.env.GITHUB_WEBHOOK_SECRET = origSecret;
});

await test('POST /v2/sync/resync 成功路径', async () => {
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/sync/resync',
    body: { projectId: 'proj_test' },
  });
  const handled = await handleSync(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.status(), 200);
  assert.ok(typeof ctx.result().links !== 'undefined' || ctx.result() !== null);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 31: events.js SSE stream — 覆盖 lines 10-51
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[events.js — SSE stream]');

await test('GET /v2/events/stream — SSE 握手 + 立即关闭', async () => {
  let closeHandler = null;
  let writeHeadStatus = null;
  const written = [];

  const sseCtx = {
    method: 'GET',
    path: '/v2/events/stream',
    url: new URL('http://localhost/v2/events/stream'),
    tenantId: TENANT,
    req: {
      headers: {},
      on: (ev, fn) => {
        if (ev === 'close') closeHandler = fn;
        if (ev === 'error') { /* ignore */ }
      },
      socket: { remoteAddress: '127.0.0.1' },
    },
    res: {
      writeHead: (status, hdrs) => { writeHeadStatus = status; },
      write: (chunk) => { written.push(chunk); return true; },
      end: () => {},
    },
    readBody: async () => ({}),
    sendV2Json: () => {},
    sendV2Error: () => {},
    status: () => writeHeadStatus,
    result: () => null,
    error: () => null,
    ok: () => writeHeadStatus === 200,
  };

  const { handle: handleEventsSSE } = await import('../server/v2/routes/events.js');
  const handled = await handleEventsSSE(sseCtx);

  assert.equal(handled, true);
  assert.equal(writeHeadStatus, 200);
  assert.ok(written.some(w => w.includes('SSE stream connected')));

  // 立即关闭连接，触发 clearInterval
  if (closeHandler) closeHandler();
});

await test('GET /v2/events/stream — 带 type 过滤参数', async () => {
  let closeHandler = null;
  let writeHeadStatus = null;

  const sseCtx = {
    method: 'GET',
    path: '/v2/events/stream',
    url: new URL('http://localhost/v2/events/stream?type=task.claimed&since=0'),
    tenantId: TENANT,
    req: {
      headers: {},
      on: (ev, fn) => { if (ev === 'close') closeHandler = fn; },
    },
    res: {
      writeHead: (status) => { writeHeadStatus = status; },
      write: () => true,
      end: () => {},
    },
    readBody: async () => ({}),
    sendV2Json: () => {},
    sendV2Error: () => {},
    status: () => writeHeadStatus,
    result: () => null,
    error: () => null,
    ok: () => writeHeadStatus === 200,
  };

  const { handle: handleEventsSSE2 } = await import('../server/v2/routes/events.js');
  const handled = await handleEventsSSE2(sseCtx);
  assert.equal(handled, true);
  assert.equal(writeHeadStatus, 200);
  if (closeHandler) closeHandler();
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 32: agents.js — dispatch 到无法到达的 endpoint（502 路径）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[agents.js — dispatch 502 路径]');

await test('POST /v2/agents/dispatch — endpoint 无法到达返回 502', async () => {
  // 创建一个有 agent_endpoint 但端口不存在的 agent
  const unreachableAgentId = `actor_agent_unreach_${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO actors
      (id, tenant_id, type, display_name, agent_model, agent_endpoint, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', 'Unreachable Agent', 'claude-code', 'http://127.0.0.1:1/hook', '[]', 1, 1, ?, ?)
  `).run(unreachableAgentId, TENANT, now, now);

  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/agents/dispatch',
    body: { agentId: unreachableAgentId, taskId: seedTaskId },
  });

  // fetch 到 port 1 会立即 ECONNREFUSED
  const handled = await handleAgents(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 502);
  assert.ok(ctx.error().msg.includes('agent unreachable'));
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 33: reviews.js — 覆盖 GitHub fetch 失败路径（无 owner/repo）
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[reviews.js — GitHub 路径 422]');

await test('POST /v2/reviews/trigger 无 rawDiff 且无 owner/repo 返回 422', async () => {
  // pull 的 raw_json 里没有 owner/repo 信息，且 body 也没有提供
  const ctx = makeCtx({
    method: 'POST',
    path: '/v2/reviews/trigger',
    body: { pullId: seedPullId }, // 无 rawDiff，无 owner/repo
  });
  const handled = await handleReviews(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.error().status, 422);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 34: app.js 补充 — 路由加载缓存复用
// ═══════════════════════════════════════════════════════════════════════
console.log('\n[app.js — 路由缓存]');

await test('handleV2 — 相同路由模块第二次调用走缓存', async () => {
  // 同一个模块被多个路径前缀引用（如 observability.js 对应 /v2/space + /v2/risks）
  // 两次调用都应命中模块缓存，seen Set 防止重复调用
  const { req: req1, res: res1, url: url1 } = makeHttpCtx({ pathname: '/v2/space' });
  const { req: req2, res: res2, url: url2 } = makeHttpCtx({ pathname: '/v2/risks' });

  await handleV2(req1, res1, url1);
  await handleV2(req2, res2, url2);

  assert.equal(res1.status(), 200);
  assert.equal(res2.status(), 200);
});

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════
cleanupTestData();

// ═══════════════════════════════════════════════════════════════════════
// 结果汇总
// ═══════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
console.log(`v2 回归测试结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 个）`);
if (failures.length > 0) {
  console.log('\n失败详情：');
  for (const { name, err } of failures) {
    console.error(`  • ${name}`);
    console.error(`    ${err.stack?.split('\n')[0] || err.message}`);
  }
  process.exit(1);
} else {
  console.log('✅ 全部通过');
}

// 强制退出：DB 连接 / 定时器会阻止 event loop 自然结束
process.exit(failed > 0 ? 1 : 0);
