/**
 * scripts/test-w9-outcome-ledger.mjs
 * W9 集成测试 — Outcome Ledger（持续学习数据层）
 *
 * 测试内容：
 *   1. recordOutcome — 记录 +1/-1/0 三种极性
 *   2. queryOutcomes — 过滤/分页查询
 *   3. computeStats  — 聚合统计和 successRate 计算
 *   4. autoLabelTaskOutcome — 规则自动打标（done/cancelled/in_review）
 *   5. autoLabelReviewOutcome — 审阅自动打标（Pass/Block/Warning）
 *   6. batchAutoLabel — 批量打标（未打标跳过，已打标不重复）
 *   7. 极性参数校验 — 非法 polarity 应抛错
 */

import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import {
  recordOutcome,
  queryOutcomes,
  computeStats,
  autoLabelTaskOutcome,
  autoLabelReviewOutcome,
  batchAutoLabel,
} from '../server/services/outcomeLedger.js';

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
const db = getDb();
const tenantId = `test_w9_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();

// ── 基础数据 ─────────────────────────────────────────────────
const projectId = `proj_w9_${tenantId.slice(-8)}`;
db.prepare(`INSERT INTO projects (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, 'W9 Test', ?, ?)`)
  .run(projectId, tenantId, now(), now());

// 创建 actors（AI agent）
const agentId = `agent_w9_${tenantId.slice(-8)}`;
await dbWrite('test:w9.actor', (db) => {
  db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', 'TestAgent', '["code","test"]', 3, 1, ?, ?)`)
    .run(agentId, tenantId, now(), now());
});

// 创建各种状态的任务
const taskDoneId   = `task_w9_done_${tenantId.slice(-8)}`;
const taskCancelId = `task_w9_cancel_${tenantId.slice(-8)}`;
const taskReviewId = `task_w9_review_${tenantId.slice(-8)}`;
const taskPendId   = `task_w9_pend_${tenantId.slice(-8)}`;

await dbWrite('test:w9.tasks', (db) => {
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '完成的任务', 'done', 'P1', 100, ?, ?, ?)`)
    .run(taskDoneId, tenantId, projectId, agentId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '取消的任务', 'cancelled', 'P2', 30, ?, ?, ?)`)
    .run(taskCancelId, tenantId, projectId, agentId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '审阅中任务', 'in_review', 'P1', 90, ?, ?, ?)`)
    .run(taskReviewId, tenantId, projectId, agentId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, '待处理任务', 'pending', 'P2', 0, ?, ?)`)
    .run(taskPendId, tenantId, projectId, now(), now());
});

// 创建 pulls（reviews 的 FK 依赖）
await dbWrite('test:w9.pulls', (db) => {
  for (const num of [1, 2, 3]) {
    db.prepare(`INSERT INTO pulls (id, tenant_id, project_id, number, title, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'W9 PR', 'open', ?, ?)`)
      .run(`pull_w9_${num}_${tenantId.slice(-8)}`, tenantId, projectId, num, now(), now());
  }
});

// 创建 reviews
const reviewPassId  = `rev_w9_pass_${tenantId.slice(-8)}`;
const reviewBlockId = `rev_w9_block_${tenantId.slice(-8)}`;
const reviewWarnId  = `rev_w9_warn_${tenantId.slice(-8)}`;

await dbWrite('test:w9.reviews', (db) => {
  db.prepare(`INSERT INTO reviews (id, tenant_id, task_id, pull_id, level, source, findings_json, created_at)
    VALUES (?, ?, ?, ?, 'Pass', 'map-reduce', '[]', ?)`)
    .run(reviewPassId, tenantId, taskDoneId, `pull_w9_1_${tenantId.slice(-8)}`, now());
  db.prepare(`INSERT INTO reviews (id, tenant_id, task_id, pull_id, level, source, findings_json, created_at)
    VALUES (?, ?, ?, ?, 'Block', 'agent', '[]', ?)`)
    .run(reviewBlockId, tenantId, taskReviewId, `pull_w9_2_${tenantId.slice(-8)}`, now());
  db.prepare(`INSERT INTO reviews (id, tenant_id, task_id, pull_id, level, source, findings_json, created_at)
    VALUES (?, ?, ?, ?, 'Warning', 'map-reduce', '[]', ?)`)
    .run(reviewWarnId, tenantId, taskPendId, `pull_w9_3_${tenantId.slice(-8)}`, now());
});

// ══════════════════════════════════════════════════════════════
// Step 1: recordOutcome — 基础记录
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 1] recordOutcome — 基础记录'));

const id1 = await recordOutcome({
  tenantId,
  actionType: 'task.dispatch',
  actionRefId: 'ref_1',
  outcomeSignal: '测试成功完成',
  polarity: 1,
  evidence: { score: 95 },
  observer: 'auto-rule',
});
assert('recordOutcome 返回数字 id', typeof id1 === 'number' && id1 > 0,
  `id: ${id1}`);

const id2 = await recordOutcome({
  tenantId,
  actionType: 'code.review',
  actionRefId: 'ref_2',
  outcomeSignal: '审阅失败，安全漏洞',
  polarity: -1,
  observer: 'auto-rule',
});
assert('负极性记录成功', typeof id2 === 'number');

const id3 = await recordOutcome({
  tenantId,
  actionType: 'recommend',
  actionRefId: 'ref_3',
  outcomeSignal: '推荐结果中性',
  polarity: 0,
  observer: 'human-label',
  lagHours: 24,
});
assert('零极性（中性）记录成功', typeof id3 === 'number');

// 验证写入 DB
const row = db.prepare('SELECT * FROM ai_outcomes WHERE id = ?').get(id1);
assert('outcome 已写入 DB', !!row);
assert('evidence_json 正确序列化', row.evidence_json === JSON.stringify({ score: 95 }));
assert('polarity 值正确', row.polarity === 1);

// ══════════════════════════════════════════════════════════════
// Step 2: queryOutcomes — 过滤/分页
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 2] queryOutcomes — 过滤/分页'));

const all = queryOutcomes({ tenantId });
assert('queryOutcomes 返回 outcomes 数组', Array.isArray(all.outcomes));
assert('queryOutcomes 返回 total', typeof all.total === 'number');
assert('total 至少包含已写入的 3 条', all.total >= 3,
  `total: ${all.total}`);

// action_type 过滤
const byType = queryOutcomes({ tenantId, actionType: 'task.dispatch' });
assert('action_type 过滤正确', byType.outcomes.every(r => r.action_type === 'task.dispatch'),
  `types: ${byType.outcomes.map(r => r.action_type).join(',')}`);

// polarity 过滤
const positiveOnly = queryOutcomes({ tenantId, polarity: 1 });
assert('polarity=+1 过滤正确', positiveOnly.outcomes.every(r => r.polarity === 1),
  `polarities: ${positiveOnly.outcomes.map(r => r.polarity).join(',')}`);

const negativeOnly = queryOutcomes({ tenantId, polarity: -1 });
assert('polarity=-1 过滤正确', negativeOnly.outcomes.every(r => r.polarity === -1));

// limit/offset 分页
const page1 = queryOutcomes({ tenantId, limit: 2, offset: 0 });
assert('limit 生效', page1.outcomes.length <= 2);
const page2 = queryOutcomes({ tenantId, limit: 2, offset: 2 });
assert('offset 分页不重复', !page2.outcomes.some(r => page1.outcomes.some(r2 => r2.id === r.id)));

// evidence 反序列化
const withEvidence = all.outcomes.find(r => r.id === id1);
assert('evidence 自动反序列化为对象', typeof withEvidence?.evidence === 'object' && withEvidence?.evidence?.score === 95);

// ══════════════════════════════════════════════════════════════
// Step 3: computeStats — 聚合统计
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 3] computeStats — 聚合统计'));

const stats = computeStats({ tenantId });
assert('stats 有 byType 数组', Array.isArray(stats.byType));
assert('stats 有 grand 汇总', typeof stats.grand === 'object');
assert('grand.total ≥ 3', stats.grand.total >= 3,
  `total: ${stats.grand.total}`);
assert('grand.successRate 是 0-100 数字', stats.grand.successRate >= 0 && stats.grand.successRate <= 100);
assert('byType 有 successRate 字段', stats.byType.every(r => typeof r.successRate === 'number'));

// 单 action_type 过滤
const taskStats = computeStats({ tenantId, actionType: 'task.dispatch' });
assert('过滤后 byType 只有 task.dispatch', taskStats.byType.every(r => r.actionType === 'task.dispatch'));
assert('task.dispatch 有 1 条正极性记录', taskStats.byType[0]?.positive >= 1);

// ══════════════════════════════════════════════════════════════
// Step 4: autoLabelTaskOutcome — 任务自动打标
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 4] autoLabelTaskOutcome — 任务自动打标'));

// done 状态 → +1
const doneId = await autoLabelTaskOutcome({ tenantId, taskId: taskDoneId });
assert('done 任务自动打标返回 id', typeof doneId === 'number',
  `id: ${doneId}`);
const doneRow = db.prepare('SELECT * FROM ai_outcomes WHERE id = ?').get(doneId);
assert('done 任务 polarity = +1', doneRow?.polarity === 1,
  `polarity: ${doneRow?.polarity}`);
assert('done 任务 observer = auto-rule', doneRow?.observer === 'auto-rule');

// cancelled 状态 → -1
const cancelId = await autoLabelTaskOutcome({ tenantId, taskId: taskCancelId });
assert('cancelled 任务自动打标成功', typeof cancelId === 'number');
const cancelRow = db.prepare('SELECT * FROM ai_outcomes WHERE id = ?').get(cancelId);
assert('cancelled 任务 polarity = -1', cancelRow?.polarity === -1);

// in_review + Block review → -1
const reviewedId = await autoLabelTaskOutcome({ tenantId, taskId: taskReviewId });
assert('in_review+Block 任务打标成功', typeof reviewedId === 'number');
const reviewedRow = db.prepare('SELECT * FROM ai_outcomes WHERE id = ?').get(reviewedId);
assert('in_review+Block polarity = -1', reviewedRow?.polarity === -1,
  `polarity: ${reviewedRow?.polarity}`);

// pending 任务 → 状态未终结，返回 null（不打标）
const pendResult = await autoLabelTaskOutcome({ tenantId, taskId: taskPendId });
assert('pending 任务返回 null（不打标）', pendResult === null);

// 不存在的任务 → 抛错
try {
  await autoLabelTaskOutcome({ tenantId, taskId: 'nonexistent_task_xyz' });
  assert('不存在任务应抛错', false);
} catch (err) {
  assert('不存在任务抛出正确错误', err.message.includes('not found'));
}

// ══════════════════════════════════════════════════════════════
// Step 5: autoLabelReviewOutcome — 审阅自动打标
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 5] autoLabelReviewOutcome — 审阅自动打标'));

const passLabelId = await autoLabelReviewOutcome({ tenantId, reviewId: reviewPassId });
assert('Pass 审阅打标成功', typeof passLabelId === 'number');
const passRow = db.prepare('SELECT * FROM ai_outcomes WHERE id = ?').get(passLabelId);
assert('Pass → polarity = +1', passRow?.polarity === 1,
  `polarity: ${passRow?.polarity}`);
assert('action_type = code.review', passRow?.action_type === 'code.review');

const blockLabelId = await autoLabelReviewOutcome({ tenantId, reviewId: reviewBlockId });
assert('Block 审阅打标成功', typeof blockLabelId === 'number');
const blockRow = db.prepare('SELECT * FROM ai_outcomes WHERE id = ?').get(blockLabelId);
assert('Block → polarity = -1', blockRow?.polarity === -1);

const warnLabelId = await autoLabelReviewOutcome({ tenantId, reviewId: reviewWarnId });
assert('Warning 审阅打标成功', typeof warnLabelId === 'number');
const warnRow = db.prepare('SELECT * FROM ai_outcomes WHERE id = ?').get(warnLabelId);
assert('Warning → polarity = 0', warnRow?.polarity === 0);

// ══════════════════════════════════════════════════════════════
// Step 6: batchAutoLabel — 批量打标
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 6] batchAutoLabel — 批量打标'));

// 创建新的未打标 agent 任务
const newTaskId = `task_w9_new_${tenantId.slice(-8)}`;
await dbWrite('test:w9.newtask', (db) => {
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '新完成任务', 'done', 'P1', 100, ?, ?, ?)`)
    .run(newTaskId, tenantId, projectId, agentId, now(), now());
});

const batchResult = await batchAutoLabel({ tenantId });
assert('batchAutoLabel 返回 tasksLabeled', typeof batchResult.tasksLabeled === 'number',
  `tasksLabeled: ${batchResult.tasksLabeled}`);
assert('batchAutoLabel 返回 reviewsLabeled', typeof batchResult.reviewsLabeled === 'number',
  `reviewsLabeled: ${batchResult.reviewsLabeled}`);
assert('新任务被打标（tasksLabeled >= 1）', batchResult.tasksLabeled >= 1,
  `tasksLabeled: ${batchResult.tasksLabeled}`);

// 幂等：再次 batch 不重复打标
const batchResult2 = await batchAutoLabel({ tenantId });
assert('第二次 batch 不重复打标（tasksLabeled = 0）', batchResult2.tasksLabeled === 0,
  `tasksLabeled: ${batchResult2.tasksLabeled}`);
assert('第二次 batch reviews 不重复（reviewsLabeled = 0）', batchResult2.reviewsLabeled === 0,
  `reviewsLabeled: ${batchResult2.reviewsLabeled}`);

// ══════════════════════════════════════════════════════════════
// Step 7: 极性参数校验
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 7] 参数校验'));

try {
  await recordOutcome({
    tenantId,
    actionType: 'test',
    actionRefId: 'ref_bad',
    outcomeSignal: '测试',
    polarity: 2, // 非法
  });
  assert('非法 polarity 应抛错', false);
} catch (err) {
  assert('非法 polarity 抛出正确错误', err.message.includes('invalid polarity'));
}

// since 过滤（未来时间 → 0 条）
const future = new Date(Date.now() + 3600 * 1000).toISOString();
const futureQuery = queryOutcomes({ tenantId, since: future });
assert('since 未来时间返回空', futureQuery.total === 0,
  `total: ${futureQuery.total}`);

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log(`\n${B('═'.repeat(55))}`);
console.log(`  W9 Outcome Ledger 测试`);
console.log(`  ${G(`✓ ${passed} passed`)}  ${failed > 0 ? R(`✗ ${failed} failed`) : ''}`);
console.log(B('═'.repeat(55)));

process.exit(failed > 0 ? 1 : 0);
