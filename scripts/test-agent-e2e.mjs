/**
 * scripts/test-agent-e2e.mjs
 * W4 E2E 集成测试 — Agent Integration Protocol 完整生命周期
 *
 * 流程：
 *   1. 初始化 DB + reducers
 *   2. 创建 ai-agent actor（带 endpoint 指向本测试的 mock server）
 *   3. 创建任务
 *   4. 写入 project_memory（验证 context injection）
 *   5. dispatch → mock endpoint 收到 payload，验证 memory/AC 字段
 *   6. callback: accepted → 任务变 claimed
 *   7. callback: completed → 任务变 in_review，写 review 记录
 *   8. callback: blocked（另一任务）→ signal 更新
 *   9. standup: agent 提交日报
 *  10. 汇总结果
 *
 * 运行：node scripts/test-agent-e2e.mjs
 */

import http from 'node:http';
import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import { emit } from '../server/events/bus.js';
import '../server/state/reducer.js';   // 注册所有 reducers
import { buildAgentContext } from '../server/services/contextInjector.js';

// ── 颜色输出 ─────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[36m${s}\x1b[0m`;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ${G('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${R('✗')} ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ── Mock HTTP server（模拟 agent endpoint）───────────────────
let _mockPayload = null;
const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try { _mockPayload = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
const MOCK_PORT = mockServer.address().port;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/agent`;
console.log(B(`[mock] agent endpoint listening at ${MOCK_URL}`));

// ── 初始化 ────────────────────────────────────────────────────
initDb();
const db = getDb();
// 每次运行使用唯一 tenant_id，避免并发运行时的数据污染
const tenantId = `test_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// 旧静态 tenant 残留清理（新 tenant 本身是空的，这里清旧数据）
for (const old of ['test_e2e']) {
  db.prepare("DELETE FROM reviews WHERE tenant_id = ?").run(old);
  db.prepare("DELETE FROM standups WHERE tenant_id = ?").run(old);
  db.prepare("DELETE FROM project_memory WHERE tenant_id = ?").run(old);
  db.prepare("DELETE FROM events WHERE tenant_id = ?").run(old);
  db.prepare("DELETE FROM tasks WHERE tenant_id = ?").run(old);
  db.prepare("DELETE FROM projects WHERE tenant_id = ?").run(old);
  db.prepare("DELETE FROM actors WHERE tenant_id = ?").run(old);
}

const now = () => new Date().toISOString();

// ══════════════════════════════════════════════════════════════
// Step 1: 注册 AI agent actor
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 1] 注册 AI agent actor'));

const agentId = `actor_agent_e2e_${Date.now()}`;
await dbWrite('test:actor.create', (db) => {
  db.prepare(`
    INSERT INTO actors
      (id, tenant_id, type, display_name, agent_model, agent_endpoint,
       capabilities_json, context_window, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', 'E2E Test Agent', 'claude-sonnet-4-6', ?, '["code","review"]', 200000, 0, 1, ?, ?)
  `).run(agentId, tenantId, MOCK_URL, now(), now());
});

const agent = db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ?').get(agentId, tenantId);
assert('agent 已注册', !!agent);
assert('agent type = ai-agent', agent?.type === 'ai-agent');
assert('agent endpoint 已配置', agent?.agent_endpoint === MOCK_URL);

// ══════════════════════════════════════════════════════════════
// Step 2: 创建项目 + 任务
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 2] 创建项目 + 任务'));

const projectId = `proj_e2e_${Date.now()}`;
db.prepare(`
  INSERT INTO projects (id, tenant_id, name, created_at, updated_at)
  VALUES (?, ?, 'E2E Test Project', ?, ?)
`).run(projectId, tenantId, now(), now());

const taskId = `task_e2e_${Date.now()}`;
await dbWrite('test:task.create', (db) => {
  db.prepare(`
    INSERT INTO tasks
      (id, tenant_id, project_id, title, acceptance, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 'P1', 0, ?, ?)
  `).run(
    taskId, tenantId, projectId,
    '实现用户登录功能',
    '- 支持邮箱密码登录\n- 登录成功后跳转首页\n- 错误信息本地化',
    now(), now()
  );
});

const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
assert('任务已创建', !!task);
assert('任务初始 state = pending', task?.state === 'pending');

// ══════════════════════════════════════════════════════════════
// Step 3: 写入 project_memory（验证 context injection）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 3] 写入 project_memory'));

const memoryEntries = [
  { kind: 'taboo', body: '禁止使用 eval() 和 innerHTML 注入，安全红线', confidence: 1.0 },
  { kind: 'gotcha', body: '所有 API 调用必须在中国境内测试时使用代理，直连超时', confidence: 0.9 },
  { kind: 'decision', body: '认证方案采用 JWT，过期时间 7 天，refresh token 30 天', confidence: 0.85 },
  { kind: 'convention', body: '组件命名采用 PascalCase，文件名 kebab-case', confidence: 0.8 },
  { kind: 'pattern', body: '所有异步操作包裹 try-catch，错误上报到 Sentry', confidence: 0.7 },
];

await dbWrite('test:memory.seed', (db) => {
  for (const m of memoryEntries) {
    db.prepare(`
      INSERT INTO project_memory (tenant_id, project_id, kind, body, confidence, source, created_at)
      VALUES (?, ?, ?, ?, ?, 'test', ?)
    `).run(tenantId, projectId, m.kind, m.body, m.confidence, now());
  }
});

const memCount = db.prepare('SELECT COUNT(*) as c FROM project_memory WHERE tenant_id = ?').get(tenantId).c;
assert(`project_memory 写入 ${memoryEntries.length} 条`, memCount === memoryEntries.length);

// ══════════════════════════════════════════════════════════════
// Step 4: buildAgentContext — 验证优先级排序和字符截断
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 4] 验证 buildAgentContext'));

const ctx = await buildAgentContext({ taskId, tenantId, agentId });

assert('payload 包含 taskId', ctx.taskId === taskId);
assert('payload 包含 acceptance', typeof ctx.acceptance === 'string' && ctx.acceptance.length > 0);
assert('payload 包含 hubCallbackUrl', ctx.hubCallbackUrl?.includes('/v2/agents/callback'));
assert('context.memory 非空', ctx.context.memory.length > 0);
assert('memory 首条是 taboo（最高优先级）', ctx.context.memory[0]?.kind === 'taboo');
assert('memoryStats.total = 5', ctx.context.memoryStats.total === 5);
assert('memoryStats.injected ≥ 1', ctx.context.memoryStats.injected >= 1);
assert('recentBlocks 是数组', Array.isArray(ctx.context.recentBlocks));
assert('recentMergedPRs 是数组', Array.isArray(ctx.context.recentMergedPRs));

// ══════════════════════════════════════════════════════════════
// Step 5: dispatch — mock endpoint 收到 payload
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 5] 模拟 dispatch（直接调用 fetch）'));

_mockPayload = null;
await fetch(MOCK_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-cue-hub-dispatch': '1' },
  body: JSON.stringify(ctx),
  signal: AbortSignal.timeout(5_000),
});
// mock server 是异步的，等一下
await new Promise(r => setTimeout(r, 100));

assert('mock endpoint 收到 dispatch', _mockPayload !== null);
assert('dispatch payload 包含 context.memory', _mockPayload?.context?.memory?.length > 0);
assert('dispatch payload memory[0].kind = taboo', _mockPayload?.context?.memory[0]?.kind === 'taboo');

// ══════════════════════════════════════════════════════════════
// Step 6: callback — accepted → 任务变 claimed
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 6] callback: accepted → claimed'));

await emit('agent.task.accepted', { tenantId, agentId, taskId }, { source: 'agent' });
await new Promise(r => setTimeout(r, 50)); // wait for async reducer

let t = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
assert('task state = claimed after accepted', t?.state === 'claimed');
assert('task actor_id = agentId', t?.actor_id === agentId);

// 幂等性：再次 accepted 不应改变任何内容
await emit('agent.task.accepted', { tenantId, agentId, taskId }, { source: 'agent' });
await new Promise(r => setTimeout(r, 50));
t = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
assert('幂等 accepted 不破坏 state', t?.state === 'claimed');

// ══════════════════════════════════════════════════════════════
// Step 7: callback — completed → in_review + review 记录
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 7] callback: completed → in_review'));

const acStatus = { '支持邮箱密码登录': true, '登录成功后跳转首页': true, '错误信息本地化': false };
const artifacts = ['https://github.com/test/repo/pull/42'];

await emit('agent.task.completed', {
  tenantId, agentId, taskId,
  artifacts,
  acStatus,
}, { source: 'agent' });
await new Promise(r => setTimeout(r, 100));

t = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
assert('task state = in_review after completed', t?.state === 'in_review');
assert('task progress = 100', t?.progress === 100);

const review = db.prepare(`
  SELECT * FROM reviews WHERE task_id = ? AND tenant_id = ? AND source = 'agent'
`).get(taskId, tenantId);
assert('agent review 记录已写入', !!review);
assert('review level = Pass（agent 自评）', review?.level === 'Pass');
const parsedAC = JSON.parse(review?.compliance_json || '{}');
assert('review compliance_json 包含 AC 状态', parsedAC['支持邮箱密码登录'] === true);

// ══════════════════════════════════════════════════════════════
// Step 8: blocked（新任务）→ signal 更新
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 8] callback: blocked → signal 更新'));

const taskId2 = `task_e2e_blocked_${Date.now()}`;
await dbWrite('test:task2.create', (db) => {
  db.prepare(`
    INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, '被阻塞的任务', 'in_progress', 'P2', 30, ?, ?)
  `).run(taskId2, tenantId, projectId, now(), now());
});

await emit('agent.task.blocked', {
  tenantId, agentId, taskId: taskId2,
  reason: '无法访问外部 API，需要代理配置',
}, { source: 'agent' });
await new Promise(r => setTimeout(r, 50));

const t2 = db.prepare('SELECT signal FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId2, tenantId);
assert('blocked: signal 已更新（包含 🚧）', t2?.signal?.startsWith('🚧'));
assert('blocked: signal 包含 agentId', t2?.signal?.includes(agentId));

// ══════════════════════════════════════════════════════════════
// Step 9: agent standup
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 9] agent standup 日报'));

const today = new Date().toISOString().slice(0, 10);
await emit('standup.submitted', {
  tenantId,
  actorId: agentId,
  date: today,
  yesterday: '完成了用户登录功能实现，PR 已提交',
  today: '开始实现注册功能，预计完成表单验证',
  blockers: '外部 API 文档不完整，需要人工确认',
}, { source: 'agent' });
await new Promise(r => setTimeout(r, 50));

const standup = db.prepare(`
  SELECT * FROM standups WHERE actor_id = ? AND tenant_id = ? AND date = ?
`).get(agentId, tenantId, today);
assert('standup 记录已写入', !!standup);
assert('standup date 正确', standup?.date === today);
assert('standup yesterday 非空', standup?.yesterday?.length > 0);
assert('standup blockers 非空', standup?.blockers?.length > 0);

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
mockServer.close();
console.log(`\n${B('═'.repeat(60))}`);
console.log(`  W4 Agent Integration Protocol E2E 测试`);
console.log(`  ${G(`✓ ${passed} passed`)}  ${failed > 0 ? R(`✗ ${failed} failed`) : ''}`);
console.log(B('═'.repeat(60)));

if (failed > 0) {
  process.exit(1);
} else {
  console.log(G('\n  🎉 W4 完整实现验证通过！'));
  process.exit(0);
}
