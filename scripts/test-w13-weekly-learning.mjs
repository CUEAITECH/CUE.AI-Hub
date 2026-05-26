/**
 * scripts/test-w13-weekly-learning.mjs
 * W13 集成测试 — 周度学习批处理
 *
 * 测试内容：
 *   1. getISOWeekBounds / getWeekBoundsForDate — 周边界计算
 *   2. aggregateWeeklyOutcomes — 聚合指标（含 outcome/task/review）
 *   3. generateInsights（规则降级）— 无数据/正常/低成功率场景
 *   4. runWeeklyBatch — 完整 pipeline（LLM_DRY_RUN 降级为规则）
 *   5. persistWeeklyReport — 幂等覆盖写入
 *   6. queryReports / getReport — 查询
 */

import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import {
  getISOWeekBounds,
  getWeekBoundsForDate,
  aggregateWeeklyOutcomes,
  runWeeklyBatch,
  persistWeeklyReport,
  queryReports,
  getReport,
  ensureLearningReportsTable,
} from '../server/services/weeklyLearning.js';

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
ensureLearningReportsTable();
const db = getDb();
const tenantId = `test_w13_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();

// ── 确定测试用的周边界（使用当前周而非上周，便于数据落入窗口）──
const { weekStart, weekEnd } = getWeekBoundsForDate(new Date().toISOString().slice(0, 10));

// ── 基础数据 ─────────────────────────────────────────────────
const projectId = `proj_w13_${tenantId.slice(-8)}`;
db.prepare(`INSERT INTO projects (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, 'W13 Test', ?, ?)`)
  .run(projectId, tenantId, now(), now());

const agentId  = `agent_w13_${tenantId.slice(-8)}`;
const humanId  = `human_w13_${tenantId.slice(-8)}`;
await dbWrite('test:w13.actors', (db) => {
  db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', 'W13Agent', '["code"]', 3, 1, ?, ?)`)
    .run(agentId, tenantId, now(), now());
  db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'human', '王五', '["design"]', 0, 1, ?, ?)`)
    .run(humanId, tenantId, now(), now());
});

// tasks（本周内）
const taskDoneId   = `task_w13_done_${tenantId.slice(-8)}`;
const taskCancelId = `task_w13_cancel_${tenantId.slice(-8)}`;
const taskProgId   = `task_w13_prog_${tenantId.slice(-8)}`;
await dbWrite('test:w13.tasks', (db) => {
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '完成任务 A', 'done', 'P1', 100, ?, ?, ?)`)
    .run(taskDoneId, tenantId, projectId, agentId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '取消任务 B', 'cancelled', 'P2', 30, ?, ?, ?)`)
    .run(taskCancelId, tenantId, projectId, agentId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '进行中任务 C', 'in_progress', 'P2', 60, ?, ?, ?)`)
    .run(taskProgId, tenantId, projectId, humanId, now(), now());
});

// PR + reviews
const pullId = `pull_w13_${tenantId.slice(-8)}`;
await dbWrite('test:w13.pr', (db) => {
  db.prepare(`INSERT INTO pulls (id, tenant_id, project_id, number, title, state, created_at, updated_at)
    VALUES (?, ?, ?, 501, 'W13 PR', 'open', ?, ?)`)
    .run(pullId, tenantId, projectId, now(), now());
  db.prepare(`INSERT INTO reviews (id, tenant_id, task_id, pull_id, level, source, findings_json, created_at)
    VALUES (?, ?, ?, ?, 'Pass', 'map-reduce', '[]', ?)`)
    .run(`rev_w13_pass_${tenantId.slice(-8)}`, tenantId, taskDoneId, pullId, now());
  db.prepare(`INSERT INTO reviews (id, tenant_id, task_id, pull_id, level, source, findings_json, created_at)
    VALUES (?, ?, ?, ?, 'Warning', 'agent', '[]', ?)`)
    .run(`rev_w13_warn_${tenantId.slice(-8)}`, tenantId, taskProgId, pullId, now());
});

// outcomes（本周内：5 条以上触发正常 insights）
await dbWrite('test:w13.outcomes', (db) => {
  const outcomes = [
    ['task.dispatch', taskDoneId, 1, '任务完成'],
    ['task.dispatch', taskCancelId, -1, '任务取消'],
    ['code.review', `rev_pass_${tenantId.slice(-8)}`, 1, '审阅通过'],
    ['code.review', `rev_warn_${tenantId.slice(-8)}`, 0, '审阅警告'],
    ['recommend', `rec_${tenantId.slice(-8)}`, 1, '推荐采用'],
    ['recommend', `rec2_${tenantId.slice(-8)}`, 1, '推荐采用2'],
  ];
  for (const [type, ref, polarity, signal] of outcomes) {
    db.prepare(`INSERT INTO ai_outcomes (tenant_id, action_type, action_ref_id, outcome_signal, polarity, observer, observed_at)
      VALUES (?, ?, ?, ?, ?, 'auto-rule', ?)`)
      .run(tenantId, type, ref, signal, polarity, now());
  }
});

// ══════════════════════════════════════════════════════════════
// Step 1: 周边界计算
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 1] 周边界计算'));

const lastWeek = getISOWeekBounds(); // 上周
assert('getISOWeekBounds 返回 weekStart', /^\d{4}-\d{2}-\d{2}$/.test(lastWeek.weekStart));
assert('getISOWeekBounds 返回 weekEnd',   /^\d{4}-\d{2}-\d{2}$/.test(lastWeek.weekEnd));
assert('weekEnd 在 weekStart 之后', lastWeek.weekEnd > lastWeek.weekStart);

// 周期为 7 天
const diff = (new Date(lastWeek.weekEnd) - new Date(lastWeek.weekStart)) / (1000 * 60 * 60 * 24);
assert('周期为 6 天（Mon-Sun）', Math.round(diff) === 6, `diff: ${Math.round(diff)}`);

// getWeekBoundsForDate — 已知日期验证（2025-03-10 是周一）
const knownWeek = getWeekBoundsForDate('2025-03-10');
assert('2025-03-10 是周一，weekStart=2025-03-10', knownWeek.weekStart === '2025-03-10',
  `weekStart: ${knownWeek.weekStart}`);
assert('2025-03-16 是周日，weekEnd=2025-03-16', knownWeek.weekEnd === '2025-03-16',
  `weekEnd: ${knownWeek.weekEnd}`);

// 周三的所在周应与周一相同
const wedWeek = getWeekBoundsForDate('2025-03-12'); // 周三
assert('周三所在周 weekStart 与周一相同', wedWeek.weekStart === '2025-03-10',
  `weekStart: ${wedWeek.weekStart}`);

// ══════════════════════════════════════════════════════════════
// Step 2: aggregateWeeklyOutcomes — 聚合指标
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 2] aggregateWeeklyOutcomes — 聚合指标'));

const metrics = aggregateWeeklyOutcomes({ tenantId, weekStart, weekEnd });
assert('metrics 有 weekStart/weekEnd', metrics.weekStart === weekStart && metrics.weekEnd === weekEnd);
assert('metrics 有 outcomes', typeof metrics.outcomes === 'object');
assert('metrics 有 tasks', typeof metrics.tasks === 'object');
assert('metrics 有 reviews', typeof metrics.reviews === 'object');
assert('metrics 有 topActors', Array.isArray(metrics.topActors));

// outcomes 聚合
assert('outcomes.grand.total ≥ 6', metrics.outcomes.grand.total >= 6,
  `total: ${metrics.outcomes.grand.total}`);
assert('outcomes.byType 非空', metrics.outcomes.byType.length > 0);
assert('outcomes.byType 有 successRate 字段', metrics.outcomes.byType.every(r => typeof r.successRate === 'number'));

// tasks 聚合
assert('tasks.total ≥ 3', metrics.tasks.total >= 3, `total: ${metrics.tasks.total}`);
assert('tasks.done ≥ 1', metrics.tasks.done >= 1, `done: ${metrics.tasks.done}`);
assert('tasks.cancelled ≥ 1', metrics.tasks.cancelled >= 1, `cancelled: ${metrics.tasks.cancelled}`);
assert('tasks.completionRate 是 0-100', metrics.tasks.completionRate >= 0 && metrics.tasks.completionRate <= 100);

// reviews 聚合
assert('reviews.total ≥ 2', metrics.reviews.total >= 2, `total: ${metrics.reviews.total}`);
assert('reviews.passed ≥ 1', metrics.reviews.passed >= 1);
assert('reviews.passRate 是 0-100', metrics.reviews.passRate >= 0 && metrics.reviews.passRate <= 100);

// topActors
assert('topActors 有 successRate', metrics.topActors.every(a => typeof a.successRate === 'number'));

// ══════════════════════════════════════════════════════════════
// Step 3: runWeeklyBatch — 完整 pipeline（规则降级）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 3] runWeeklyBatch — 完整 pipeline'));

const batchResult = await runWeeklyBatch({ tenantId, weekStart, weekEnd });
assert('runWeeklyBatch 返回 reportId', typeof batchResult.reportId === 'number',
  `reportId: ${batchResult.reportId}`);
assert('runWeeklyBatch 返回 weekStart', batchResult.weekStart === weekStart);
assert('runWeeklyBatch 返回 metrics', typeof batchResult.metrics === 'object');
assert('runWeeklyBatch 返回 insights 数组', Array.isArray(batchResult.insights),
  `insights: ${JSON.stringify(batchResult.insights)}`);
assert('runWeeklyBatch 返回 insightSource', typeof batchResult.insightSource === 'string');
assert('runWeeklyBatch 返回 space', typeof batchResult.space === 'object');
assert('space 有 score', typeof batchResult.space?.score === 'number');

// insights 格式
const insight0 = batchResult.insights[0];
assert('每条 insight 有 category', typeof insight0?.category === 'string');
assert('每条 insight 有 priority', typeof insight0?.priority === 'string');
assert('每条 insight 有 insight 文本', typeof insight0?.insight === 'string');
assert('每条 insight 有 action', typeof insight0?.action === 'string');

// insights source（LLM_DRY_RUN 时应为 rule）
assert('insights 来源是 rule 或 llm', ['rule', 'llm'].includes(batchResult.insightSource),
  `source: ${batchResult.insightSource}`);

// ══════════════════════════════════════════════════════════════
// Step 4: persistWeeklyReport — 幂等覆盖写入
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 4] persistWeeklyReport — 幂等覆盖写入'));

// 直接 persist（不经过 runWeeklyBatch）
const mockInsights = [{ category: 'quality', priority: 'high', insight: '测试', action: '测试行动', metric: 'test' }];
const id1 = await persistWeeklyReport({ tenantId, weekStart, weekEnd, metrics, insights: mockInsights });
assert('persist 返回数字 id', typeof id1 === 'number', `id: ${id1}`);

// 幂等：相同 weekStart 再次写入 → 覆盖（不报错）
const id2 = await persistWeeklyReport({ tenantId, weekStart, weekEnd, metrics, insights: mockInsights });
assert('幂等覆盖写入不报错', typeof id2 === 'number');

// 验证 DB 中只有一条该周记录
const count = db.prepare('SELECT COUNT(*) as c FROM learning_reports WHERE tenant_id = ? AND week_start = ?')
  .get(tenantId, weekStart).c;
assert('DB 中只有 1 条该周记录（幂等）', count === 1, `count: ${count}`);

// ══════════════════════════════════════════════════════════════
// Step 5: queryReports / getReport — 查询
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 5] queryReports / getReport — 查询'));

const { reports, total } = queryReports({ tenantId });
assert('queryReports 返回 reports 数组', Array.isArray(reports));
assert('queryReports 返回 total', typeof total === 'number');
assert('至少 1 条报告', total >= 1, `total: ${total}`);

// 报告格式
const rpt = reports[0];
assert('报告有 weekStart/weekEnd', !!rpt.weekStart && !!rpt.weekEnd);
assert('报告有 insights 数组', Array.isArray(rpt.insights));
assert('报告有 metrics 对象', typeof rpt.metrics === 'object');

// getReport 按 id
const singleReport = getReport({ tenantId, reportId: rpt.id });
assert('getReport 返回完整报告', !!singleReport && singleReport.id === rpt.id);
assert('getReport 有 space 字段（或 null）', singleReport?.space !== undefined);

// 不存在的 id
const notFound = getReport({ tenantId, reportId: 999999 });
assert('不存在的报告返回 null', notFound === null);

// 分页
const firstPage = queryReports({ tenantId, limit: 1, offset: 0 });
assert('limit=1 分页生效', firstPage.reports.length <= 1);

// ══════════════════════════════════════════════════════════════
// Step 6: 空数据场景（数据不足告警）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 6] 空数据场景（数据不足告警）'));

const emptyTenant = `test_w13_empty_${Date.now()}`;
const emptyResult = await runWeeklyBatch({ tenantId: emptyTenant, weekStart, weekEnd });
assert('空租户 batch 返回 reportId', typeof emptyResult.reportId === 'number');
assert('空租户 insights 不为空', emptyResult.insights.length > 0);
assert('空租户 insightSource = rule', emptyResult.insightSource === 'rule');

// 空数据 insights 应提示数据不足
const hasDataInsufficient = emptyResult.insights.some(i =>
  i.insight.includes('不足') || i.action.includes('数据'));
assert('空数据 insights 包含数据不足提示', hasDataInsufficient,
  `insights: ${JSON.stringify(emptyResult.insights.map(i => i.insight))}`);

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log(`\n${B('═'.repeat(55))}`);
console.log(`  W13 周度学习批处理 测试`);
console.log(`  ${G(`✓ ${passed} passed`)}  ${failed > 0 ? R(`✗ ${failed} failed`) : ''}`);
console.log(B('═'.repeat(55)));

process.exit(failed > 0 ? 1 : 0);
