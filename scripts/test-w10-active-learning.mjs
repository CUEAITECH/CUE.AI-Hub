/**
 * scripts/test-w10-active-learning.mjs
 * W10 集成测试 — Active Learning Queue + Observability
 *
 * 测试内容：
 *   1. enqueue — 入队（幂等）
 *   2. dequeue — 查询/过滤/分页
 *   3. label   — 人工打标 → 写入 ai_outcomes
 *   4. dismiss — 忽略
 *   5. queueStats — 队列统计
 *   6. autoEnqueue — 规则自动入队（中性 outcome + Block review）
 *   7. computeHealth — 可观测性健康度聚合
 */

import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import {
  enqueue,
  dequeue,
  label,
  dismiss,
  queueStats,
  autoEnqueue,
  ensureLearningQueueTable,
} from '../server/services/activeLearning.js';
import { computeHealth } from '../server/services/observability.js';
import { recordOutcome } from '../server/services/outcomeLedger.js';

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[36m${s}\x1b[0m`;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ${G('✓')} ${label}`); passed++; }
  else       { console.log(`  ${R('✗')} ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

initDb();
ensureLearningQueueTable();
const db = getDb();
const tenantId = `test_w10_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();

// ── 基础数据 ─────────────────────────────────────────────────
const projectId = `proj_w10_${tenantId.slice(-8)}`;
db.prepare(`INSERT INTO projects (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, 'W10 Test', ?, ?)`)
  .run(projectId, tenantId, now(), now());

// AI agent
const agentId = `agent_w10_${tenantId.slice(-8)}`;
await dbWrite('test:w10.actor', (db) => {
  db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', 'W10Agent', '["code"]', 3, 1, ?, ?)`)
    .run(agentId, tenantId, now(), now());
});

// 任务（done + in_review）
const taskDoneId   = `task_w10_done_${tenantId.slice(-8)}`;
const taskReviewId = `task_w10_review_${tenantId.slice(-8)}`;
await dbWrite('test:w10.tasks', (db) => {
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '完成任务', 'done', 'P1', 100, ?, ?, ?)`)
    .run(taskDoneId, tenantId, projectId, agentId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '审阅中任务', 'in_review', 'P0', 90, ?, ?, ?)`)
    .run(taskReviewId, tenantId, projectId, agentId, now(), now());
});

// PR + review（用于 autoEnqueue Block 规则）
const pullId     = `pull_w10_${tenantId.slice(-8)}`;
const reviewId   = `rev_w10_block_${tenantId.slice(-8)}`;
await dbWrite('test:w10.pr', (db) => {
  db.prepare(`INSERT INTO pulls (id, tenant_id, project_id, number, title, state, created_at, updated_at)
    VALUES (?, ?, ?, 201, 'P0 PR', 'open', ?, ?)`)
    .run(pullId, tenantId, projectId, now(), now());
  db.prepare(`INSERT INTO reviews (id, tenant_id, task_id, pull_id, level, source, findings_json, created_at)
    VALUES (?, ?, ?, ?, 'Block', 'map-reduce', '[]', ?)`)
    .run(reviewId, tenantId, taskReviewId, pullId, now());
});

// ══════════════════════════════════════════════════════════════
// Step 1: enqueue — 入队
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 1] enqueue — 入队'));

const q1id = await enqueue({
  tenantId,
  actionType:  'task.dispatch',
  actionRefId: taskDoneId,
  reason:      '任务完成度不确定，需要人工核实',
  priority:    7,
  metadata:    { source: 'test' },
});
assert('enqueue 返回数字 id', typeof q1id === 'number' && q1id > 0,
  `id: ${q1id}`);

// 验证写入 DB
const row = db.prepare('SELECT * FROM learning_queue WHERE id = ?').get(q1id);
assert('写入 learning_queue 表', !!row);
assert('priority 正确', row.priority === 7);
assert('status = pending', row.status === 'pending');
assert('metadata_json 正确序列化', row.metadata_json === JSON.stringify({ source: 'test' }));

// 幂等：同一 action_type+action_ref_id 不重复入队
const q1dup = await enqueue({
  tenantId,
  actionType:  'task.dispatch',
  actionRefId: taskDoneId,
  reason:      '重复入队测试',
  priority:    5,
});
assert('重复 enqueue 返回 null（幂等）', q1dup === null,
  `returned: ${q1dup}`);

const queueCount = db.prepare('SELECT COUNT(*) as c FROM learning_queue WHERE tenant_id = ? AND action_ref_id = ?')
  .get(tenantId, taskDoneId).c;
assert('DB 中无重复记录', queueCount === 1, `count: ${queueCount}`);

// 添加更多待测条目
const q2id = await enqueue({
  tenantId,
  actionType:  'code.review',
  actionRefId: reviewId,
  reason:      'Block 审阅需要人工决定',
  priority:    9,
});
const q3id = await enqueue({
  tenantId,
  actionType:  'recommend',
  actionRefId: 'ref_recommend_w10',
  reason:      '推荐置信度低',
  priority:    3,
});
assert('第二条入队成功', typeof q2id === 'number');
assert('第三条入队成功', typeof q3id === 'number');

// ══════════════════════════════════════════════════════════════
// Step 2: dequeue — 查询/过滤/分页
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 2] dequeue — 查询/过滤/分页'));

const pending = dequeue({ tenantId });
assert('dequeue 返回 items 数组', Array.isArray(pending.items));
assert('dequeue 返回 total', typeof pending.total === 'number');
assert('pending 队列有 3 条', pending.total === 3,
  `total: ${pending.total}`);

// 高优先级排在前（priority DESC）
assert('高优先级条目排在前', pending.items[0]?.priority >= pending.items[pending.items.length - 1]?.priority);

// action_type 过滤
const reviewOnly = dequeue({ tenantId, actionType: 'code.review' });
assert('action_type 过滤正确', reviewOnly.items.every(i => i.action_type === 'code.review'));
assert('code.review 有 1 条', reviewOnly.total === 1, `total: ${reviewOnly.total}`);

// 分页
const page1 = dequeue({ tenantId, limit: 2, offset: 0 });
const page2 = dequeue({ tenantId, limit: 2, offset: 2 });
assert('limit 生效', page1.items.length === 2);
assert('offset 分页不重复', !page2.items.some(i => page1.items.some(j => j.id === i.id)));

// metadata 反序列化
const itemWithMeta = pending.items.find(i => i.id === q1id);
assert('metadata 自动反序列化', typeof itemWithMeta?.metadata === 'object' && itemWithMeta?.metadata?.source === 'test');

// ══════════════════════════════════════════════════════════════
// Step 3: label — 人工打标
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 3] label — 人工打标'));

const labelResult = await label({
  tenantId,
  queueId:   q1id,
  polarity:  1,
  signal:    '经人工核实，任务完成质量良好',
  labeledBy: 'tech-lead',
});
assert('label 返回 outcomeId', typeof labelResult.outcomeId === 'number',
  `outcomeId: ${labelResult.outcomeId}`);

// 验证 learning_queue 状态更新
const labeled = db.prepare('SELECT * FROM learning_queue WHERE id = ?').get(q1id);
assert('status 更新为 labeled', labeled.status === 'labeled');
assert('labeled_polarity 正确', labeled.labeled_polarity === 1);
assert('labeled_by 正确', labeled.labeled_by === 'tech-lead');
assert('labeled_at 有值', !!labeled.labeled_at);

// 验证 ai_outcomes 有对应记录
const outcome = db.prepare('SELECT * FROM ai_outcomes WHERE id = ?').get(labelResult.outcomeId);
assert('ai_outcomes 有写入记录', !!outcome);
assert('observer = human-label', outcome.observer === 'human-label');
assert('outcome polarity = +1', outcome.polarity === 1);

// 重复标注应抛错
try {
  await label({ tenantId, queueId: q1id, polarity: -1, signal: '重复标注' });
  assert('重复标注应抛错', false);
} catch (err) {
  assert('重复标注抛出正确错误', err.message.includes('already labeled'));
}

// 不存在的 queueId 应抛错
try {
  await label({ tenantId, queueId: 999999, polarity: 0, signal: '测试' });
  assert('不存在 queueId 应抛错', false);
} catch (err) {
  assert('不存在 queueId 抛出正确错误', err.message.includes('not found'));
}

// ══════════════════════════════════════════════════════════════
// Step 4: dismiss — 忽略
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 4] dismiss — 忽略'));

const dismissOk = await dismiss({ tenantId, queueId: q3id });
assert('dismiss 返回 true', dismissOk === true,
  `returned: ${dismissOk}`);

const dismissedRow = db.prepare('SELECT status FROM learning_queue WHERE id = ?').get(q3id);
assert('status 更新为 dismissed', dismissedRow.status === 'dismissed');

// 已 dismiss 的条目再次 dismiss → false（不影响）
const dismissOk2 = await dismiss({ tenantId, queueId: q3id });
assert('已 dismissed 再次 dismiss 返回 false', dismissOk2 === false);

// ══════════════════════════════════════════════════════════════
// Step 5: queueStats — 统计
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 5] queueStats — 队列统计'));

const stats = queueStats({ tenantId });
assert('stats 有 byStatus', typeof stats.byStatus === 'object');
assert('stats 有 total', typeof stats.total === 'number');
assert('stats 有 labelRate', typeof stats.labelRate === 'number');
assert('total = 3 条', stats.total === 3, `total: ${stats.total}`);
assert('pending = 1 条（label 1, dismiss 1）', stats.byStatus.pending === 1,
  `pending: ${stats.byStatus.pending}`);
assert('labeled = 1 条', stats.byStatus.labeled === 1,
  `labeled: ${stats.byStatus.labeled}`);
assert('dismissed = 1 条', stats.byStatus.dismissed === 1,
  `dismissed: ${stats.byStatus.dismissed}`);
assert('labelRate = 33%（1/3）', stats.labelRate === 33,
  `labelRate: ${stats.labelRate}`);

// dequeue 状态过滤
const labeledItems = dequeue({ tenantId, status: 'labeled' });
assert('status=labeled 过滤正确', labeledItems.items.every(i => i.status === 'labeled'));
const dismissedItems = dequeue({ tenantId, status: 'dismissed' });
assert('status=dismissed 过滤正确', dismissedItems.items.every(i => i.status === 'dismissed'));

// ══════════════════════════════════════════════════════════════
// Step 6: autoEnqueue — 规则自动入队
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 6] autoEnqueue — 规则自动入队'));

// 先插入一个 neutral outcome（规则 1：polarity=0）
await recordOutcome({
  tenantId,
  actionType: 'recommend',
  actionRefId: 'ref_neutral_w10',
  outcomeSignal: '推荐结果不确定',
  polarity: 0,
  observer: 'auto-rule',
});

const autoResult = await autoEnqueue({ tenantId });
assert('autoEnqueue 返回 enqueued 数量', typeof autoResult.enqueued === 'number',
  `enqueued: ${autoResult.enqueued}`);
assert('至少入队 1 条（neutral outcome 或 Block review）', autoResult.enqueued >= 1,
  `enqueued: ${autoResult.enqueued}`);

// 幂等：再次 autoEnqueue 不重复入队
const autoResult2 = await autoEnqueue({ tenantId });
assert('第二次 autoEnqueue 幂等', autoResult2.enqueued === 0,
  `enqueued: ${autoResult2.enqueued}`);

// ══════════════════════════════════════════════════════════════
// Step 7: computeHealth — 可观测性健康度
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 7] computeHealth — 可观测性健康度'));

const health = computeHealth({ tenantId });
assert('health 有 score (0-100)', health.score >= 0 && health.score <= 100,
  `score: ${health.score}`);
assert('health 有 grade', typeof health.grade === 'string' && health.grade.length > 0);
assert('health 有 components', typeof health.components === 'object');
assert('components 有 agent', typeof health.components.agent === 'object');
assert('components 有 pipeline', typeof health.components.pipeline === 'object');
assert('components 有 learning', typeof health.components.learning === 'object');
assert('components 有 sync', typeof health.components.sync === 'object');
assert('health 有 alerts 数组', Array.isArray(health.alerts));
assert('health 有 computedAt', typeof health.computedAt === 'string');

// agent 指标
const agentComp = health.components.agent;
assert('agent.activeAgents ≥ 1', agentComp.activeAgents >= 1, `agents: ${agentComp.activeAgents}`);
assert('agent.score 是 0-100', agentComp.score >= 0 && agentComp.score <= 100);

// pipeline 指标
const pipeComp = health.components.pipeline;
assert('pipeline.totalReviews ≥ 1', pipeComp.totalReviews >= 1, `reviews: ${pipeComp.totalReviews}`);
assert('pipeline.blockedReviews ≥ 1（有 Block review）', pipeComp.blockedReviews >= 1);

// sync 指标
const syncComp = health.components.sync;
assert('sync.totalPRs ≥ 1', syncComp.totalPRs >= 1, `prs: ${syncComp.totalPRs}`);
assert('sync.linkCoverage 是 0-100', syncComp.linkCoverage >= 0 && syncComp.linkCoverage <= 100);

// 指定 since 参数
const futureHealth = computeHealth({ tenantId, since: new Date(Date.now() + 3600 * 1000).toISOString() });
assert('since 未来时间 health 仍然正常返回', typeof futureHealth.score === 'number');

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log(`\n${B('═'.repeat(55))}`);
console.log(`  W10 Active Learning Queue + Observability 测试`);
console.log(`  ${G(`✓ ${passed} passed`)}  ${failed > 0 ? R(`✗ ${failed} failed`) : ''}`);
console.log(B('═'.repeat(55)));

process.exit(failed > 0 ? 1 : 0);
