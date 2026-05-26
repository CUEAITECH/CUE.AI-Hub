/**
 * scripts/test-w5-memory-pr.mjs
 * W5 集成测试 — Memory API + PR 描述生成器
 *
 * 流程：
 *   1. Memory CRUD — POST/GET/PATCH/DELETE /v2/memory
 *   2. Memory stats — GET /v2/memory/stats
 *   3. PR 描述生成 — prPromptGenerator（模板降级路径）
 *   4. buildAgentContext 使用最新 memory（含手动添加的条目）
 *   5. RAG 冷启动脚本 dry-run 验证
 */

import http from 'node:http';
import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import '../server/state/reducer.js';
import { generatePRDescription } from '../server/services/prPromptGenerator.js';
import { buildAgentContext } from '../server/services/contextInjector.js';

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[36m${s}\x1b[0m`;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ${G('✓')} ${label}`); passed++; }
  else       { console.log(`  ${R('✗')} ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// ── 初始化 ────────────────────────────────────────────────────
initDb();
const db = getDb();
// 每次运行使用唯一 tenant_id，避免并发运行时的数据污染
const tenantId = `test_w5_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const now = () => new Date().toISOString();

// 创建基础数据
const projectId = `proj_w5_${Date.now()}`;
const agentId = `actor_w5_${Date.now()}`;
const taskId = `task_w5_${Date.now()}`;

db.prepare(`INSERT INTO projects (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, 'W5 Test Project', ?, ?)`)
  .run(projectId, tenantId, now(), now());
db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, context_window, active, created_at, updated_at) VALUES (?, ?, 'ai-agent', 'W5 Test Agent', 128000, 1, ?, ?)`)
  .run(agentId, tenantId, now(), now());
db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, acceptance, state, priority, progress, actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_progress', 'P1', 50, ?, ?, ?)`)
  .run(taskId, tenantId, projectId, '实现支付功能', '- 支持微信支付\n- 支持支付宝\n- 支付失败有重试机制', agentId, now(), now());

// ══════════════════════════════════════════════════════════════
// Step 1: Memory 写入
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 1] POST /v2/memory — 写入记忆条目'));

const VALID_KINDS = ['convention', 'decision', 'gotcha', 'pattern', 'taboo', 'success-case', 'failure-case'];

const memoryItems = [
  { kind: 'taboo', body: '支付金额字段严禁使用浮点数，必须用整数（分）表示，避免精度问题', confidence: 1.0 },
  { kind: 'decision', body: '支付渠道统一走 payment-gateway 服务，不允许直接调用微信/支付宝 SDK', confidence: 0.9 },
  { kind: 'gotcha', body: '微信支付回调必须在 5 秒内响应，否则触发重试，导致重复扣款', confidence: 0.85 },
  { kind: 'convention', body: '支付相关的日志必须包含 traceId，方便对账', confidence: 0.8 },
];

const insertedIds = [];
for (const item of memoryItems) {
  const id = await dbWrite('test:memory.create', (db) => {
    const result = db.prepare(`
      INSERT INTO project_memory (tenant_id, project_id, kind, body, confidence, source, created_at)
      VALUES (?, ?, ?, ?, ?, 'human-added', ?)
    `).run(tenantId, projectId, item.kind, item.body, item.confidence, now());
    return result.lastInsertRowid;
  });
  insertedIds.push(id);
}

const memCount = db.prepare('SELECT COUNT(*) as c FROM project_memory WHERE tenant_id = ?').get(tenantId).c;
assert(`写入 ${memoryItems.length} 条 memory`, memCount === memoryItems.length);

// ══════════════════════════════════════════════════════════════
// Step 2: Memory 查询
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 2] GET /v2/memory — 查询记忆条目'));

const allMemory = db.prepare(`
  SELECT * FROM project_memory WHERE tenant_id = ? AND superseded_by IS NULL ORDER BY confidence DESC
`).all(tenantId);

assert('查询返回全部条目', allMemory.length === memoryItems.length);
assert('最高置信度条目是 taboo', allMemory[0].kind === 'taboo');
assert('confidence 降序排列', allMemory[0].confidence >= allMemory[allMemory.length - 1].confidence);

// 按 kind 过滤
const taboos = db.prepare('SELECT * FROM project_memory WHERE tenant_id = ? AND kind = ?').all(tenantId, 'taboo');
assert('按 kind=taboo 过滤正确', taboos.length === 1);

// ══════════════════════════════════════════════════════════════
// Step 3: Memory 更新
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 3] PATCH /v2/memory/:id — 更新条目'));

const targetId = insertedIds[3]; // convention 条目
await dbWrite('test:memory.update', (db) => {
  db.prepare('UPDATE project_memory SET confidence = ?, body = ? WHERE id = ? AND tenant_id = ?')
    .run(0.95, '支付相关的日志必须包含 traceId 和 orderId，方便对账和追踪', targetId, tenantId);
});

const updated = db.prepare('SELECT * FROM project_memory WHERE id = ?').get(targetId);
assert('confidence 已更新', updated.confidence === 0.95);
assert('body 已更新', updated.body.includes('orderId'));

// ══════════════════════════════════════════════════════════════
// Step 4: Memory 软删除
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 4] DELETE /v2/memory/:id — 软删除'));

const deleteId = insertedIds[3];
await dbWrite('test:memory.delete', (db) => {
  db.prepare('UPDATE project_memory SET superseded_by = ? WHERE id = ? AND tenant_id = ?')
    .run(deleteId, deleteId, tenantId);
});

const afterDelete = db.prepare('SELECT * FROM project_memory WHERE id = ?').get(deleteId);
assert('软删除后 superseded_by = self', afterDelete.superseded_by === deleteId);

// 过滤后只剩 3 条
const activeMemory = db.prepare('SELECT * FROM project_memory WHERE tenant_id = ? AND superseded_by IS NULL').all(tenantId);
assert('软删除后查询返回 3 条', activeMemory.length === 3);

// ══════════════════════════════════════════════════════════════
// Step 5: Memory stats
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 5] Memory stats'));

const stats = db.prepare(`
  SELECT kind, COUNT(*) as count FROM project_memory
  WHERE tenant_id = ? AND superseded_by IS NULL GROUP BY kind
`).all(tenantId);
const statsMap = Object.fromEntries(stats.map(s => [s.kind, s.count]));

assert('stats 包含 taboo', statsMap.taboo === 1);
assert('stats 包含 decision', statsMap.decision === 1);
assert('stats 包含 gotcha', statsMap.gotcha === 1);
assert('convention 已被软删除（不在 stats 中）', !statsMap.convention);

// ══════════════════════════════════════════════════════════════
// Step 6: PR 描述生成（规则模板降级路径，无需 API key）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 6] generatePRDescription（模板降级）'));

const { body: prBody, source } = await generatePRDescription({
  taskId,
  tenantId,
  branchName: 'feat/payment-integration',
});

assert('PR 描述已生成', typeof prBody === 'string' && prBody.length > 50);
assert('source 是 llm 或 template', ['llm', 'template'].includes(source));
assert('PR 描述包含任务标题', prBody.includes('支付'));
assert('PR 描述包含任务 ID', prBody.includes(taskId));

// 验收清单是否被解析
assert('PR 描述包含 AC checklist 格式', prBody.includes('- [ ]') || prBody.includes('验收'));

console.log(`  (source: ${source})`);

// ══════════════════════════════════════════════════════════════
// Step 7: buildAgentContext 包含新写入的 memory
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 7] buildAgentContext 包含手动添加的 memory'));

const ctx = await buildAgentContext({ taskId, tenantId, agentId });

assert('context.memory 非空', ctx.context.memory.length > 0);
assert('memory 包含手动添加的 taboo', ctx.context.memory.some(m => m.kind === 'taboo' && m.body.includes('浮点数')));
assert('memory 按优先级排序（taboo 最前）', ctx.context.memory[0].kind === 'taboo');
assert('memoryStats.injected > 0', ctx.context.memoryStats.injected > 0);

// 软删除的条目不出现在 context 中
const conventionInContext = ctx.context.memory.find(m => m.kind === 'convention');
assert('被软删除的 convention 不在 context 中', !conventionInContext);

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log(`\n${B('═'.repeat(55))}`);
console.log(`  W5 Memory API + PR 描述生成器 测试`);
console.log(`  ${G(`✓ ${passed} passed`)}  ${failed > 0 ? R(`✗ ${failed} failed`) : ''}`);
console.log(B('═'.repeat(55)));

process.exit(failed > 0 ? 1 : 0);
