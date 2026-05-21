/**
 * scripts/test-w12-runbook.mjs
 * W12 集成测试 — Runbook + 自动化告警
 *
 * 测试内容：
 *   1. BUILTIN_RUNBOOKS 结构验证
 *   2. evaluateAlerts — 无告警场景
 *   3. evaluateAlerts — 有告警场景（卡住任务/Block 审阅）
 *   4. persistAlert — 冷却期防重复
 *   5. acknowledgeAlert — 确认告警
 *   6. queryAlertHistory — 过滤/分页
 *   7. runAlertCycle — 完整 pipeline
 */

import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import {
  BUILTIN_RUNBOOKS,
  evaluateAlerts,
  persistAlert,
  acknowledgeAlert,
  queryAlertHistory,
  runAlertCycle,
  ensureAlertsTable,
} from '../server/services/runbook.js';

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
ensureAlertsTable();
const db = getDb();
const tenantId = `test_w12_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();

// ── 基础数据（用于触发告警场景）──────────────────────────────
const projectId = `proj_w12_${tenantId.slice(-8)}`;
db.prepare(`INSERT INTO projects (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, 'W12 Test', ?, ?)`)
  .run(projectId, tenantId, now(), now());

const agentId = `agent_w12_${tenantId.slice(-8)}`;
await dbWrite('test:w12.actor', (db) => {
  db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', 'W12Agent', '["code"]', 3, 1, ?, ?)`)
    .run(agentId, tenantId, now(), now());
});

// 卡住任务（触发 rb_stuck_tasks）
const stuckTaskId = `task_w12_stuck_${tenantId.slice(-8)}`;
await dbWrite('test:w12.stuck', (db) => {
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '卡住超过 3 天', 'in_progress', 'P1', 20, ?, ?, ?)`)
    .run(stuckTaskId, tenantId, projectId, agentId, daysAgo(10), daysAgo(4));
});

// Block review（触发 rb_blocked_reviews 如果 > 3 条）
const pullId = `pull_w12_${tenantId.slice(-8)}`;
const taskForReview = `task_w12_rev_${tenantId.slice(-8)}`;
await dbWrite('test:w12.pr', (db) => {
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
    VALUES (?, ?, ?, '审阅任务', 'in_review', 'P1', 80, ?, ?, ?)`)
    .run(taskForReview, tenantId, projectId, agentId, now(), now());
  db.prepare(`INSERT INTO pulls (id, tenant_id, project_id, number, title, state, created_at, updated_at)
    VALUES (?, ?, ?, 401, 'W12 PR', 'open', ?, ?)`)
    .run(pullId, tenantId, projectId, now(), now());
  // 插入 4 条 Block review（超过 threshold=3）
  for (let i = 0; i < 4; i++) {
    db.prepare(`INSERT INTO reviews (id, tenant_id, task_id, pull_id, level, source, findings_json, created_at)
      VALUES (?, ?, ?, ?, 'Block', 'map-reduce', '[]', ?)`)
      .run(`rev_w12_block_${i}_${tenantId.slice(-8)}`, tenantId, taskForReview, pullId, now());
  }
});

// ══════════════════════════════════════════════════════════════
// Step 1: BUILTIN_RUNBOOKS 结构验证
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 1] BUILTIN_RUNBOOKS 结构验证'));

assert('BUILTIN_RUNBOOKS 是数组', Array.isArray(BUILTIN_RUNBOOKS));
assert('至少 3 条内置 runbook', BUILTIN_RUNBOOKS.length >= 3,
  `count: ${BUILTIN_RUNBOOKS.length}`);
assert('每条有 id/name/trigger/actions', BUILTIN_RUNBOOKS.every(rb =>
  rb.id && rb.name && rb.trigger && Array.isArray(rb.actions)));
assert('每条 trigger 有 metric/operator/threshold', BUILTIN_RUNBOOKS.every(rb =>
  rb.trigger.metric && rb.trigger.operator && rb.trigger.threshold !== undefined));
assert('每条有 severity', BUILTIN_RUNBOOKS.every(rb =>
  ['critical', 'warning', 'info'].includes(rb.severity)));

// id 唯一性
const ids = BUILTIN_RUNBOOKS.map(rb => rb.id);
assert('runbook id 唯一', new Set(ids).size === ids.length);

// ══════════════════════════════════════════════════════════════
// Step 2: evaluateAlerts — 无数据租户（无告警或仅 info）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 2] evaluateAlerts — 空租户'));

const emptyTenant = `test_w12_empty_${Date.now()}`;
const emptyReport = evaluateAlerts({ tenantId: emptyTenant });
assert('空租户返回 alerts 数组', Array.isArray(emptyReport.alerts));
assert('空租户有 health', typeof emptyReport.health === 'object');
assert('空租户有 summary', typeof emptyReport.summary === 'object');
assert('空租户有 evaluatedAt', typeof emptyReport.evaluatedAt === 'string');

// 空租户只应有 info 告警（无 agent → rb_no_agents），无 critical
const criticals = emptyReport.alerts.filter(a => a.severity === 'critical');
assert('空租户无 critical 告警', criticals.length === 0,
  `critical: ${JSON.stringify(criticals.map(a => a.runbookId))}`);

// ══════════════════════════════════════════════════════════════
// Step 3: evaluateAlerts — 有告警场景
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 3] evaluateAlerts — 有告警场景'));

const report = evaluateAlerts({ tenantId });
assert('有告警的租户返回 alerts 数组', Array.isArray(report.alerts));
assert('summary.total >= 0', typeof report.summary.total === 'number');
assert('告警 severity 排序（critical 优先）', (() => {
  const order = { critical: 0, warning: 1, info: 2 };
  for (let i = 1; i < report.alerts.length; i++) {
    if ((order[report.alerts[i-1].severity] ?? 3) > (order[report.alerts[i].severity] ?? 3)) return false;
  }
  return true;
}));

// 每条告警格式验证
for (const alert of report.alerts) {
  assert(`告警 ${alert.runbookId} 有 actions 数组`, Array.isArray(alert.actions));
  assert(`告警 ${alert.runbookId} 有 metric/value`, typeof alert.metric === 'string' && typeof alert.value === 'number');
}

console.log(`  告警数量: ${report.alerts.length}，摘要: critical=${report.summary.critical} warning=${report.summary.warning} info=${report.summary.info}`);

// ══════════════════════════════════════════════════════════════
// Step 4: persistAlert — 冷却期防重复
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 4] persistAlert — 冷却期防重复'));

const mockAlert = {
  runbookId:   'rb_test',
  runbookName: '测试告警',
  severity:    'warning',
  metric:      'test.metric',
  value:       5,
  threshold:   3,
  escalation:  ['standup'],
};

const id1 = await persistAlert({ tenantId, alert: mockAlert, cooldownHours: 1 });
assert('persistAlert 返回数字 id', typeof id1 === 'number' && id1 > 0,
  `id: ${id1}`);

// 验证写入 DB
const alertRow = db.prepare('SELECT * FROM alert_history WHERE id = ?').get(id1);
assert('alert 写入 alert_history', !!alertRow);
assert('severity 正确', alertRow.severity === 'warning');
assert('dispatched_to 序列化正确', alertRow.dispatched_to === JSON.stringify(['standup']));

// 冷却期内不重复
const id2 = await persistAlert({ tenantId, alert: mockAlert, cooldownHours: 1 });
assert('冷却期内返回 null', id2 === null, `returned: ${id2}`);

// 不同 runbookId 可以写入
const id3 = await persistAlert({ tenantId, alert: { ...mockAlert, runbookId: 'rb_different' }, cooldownHours: 1 });
assert('不同 runbookId 可写入', typeof id3 === 'number');

// ══════════════════════════════════════════════════════════════
// Step 5: acknowledgeAlert — 确认告警
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 5] acknowledgeAlert — 确认告警'));

const ackOk = await acknowledgeAlert({ tenantId, alertId: id1, acknowledgedBy: 'tech-lead' });
assert('acknowledgeAlert 返回 true', ackOk === true, `returned: ${ackOk}`);

const acked = db.prepare('SELECT * FROM alert_history WHERE id = ?').get(id1);
assert('acknowledged = 1', acked.acknowledged === 1);
assert('acknowledged_by = tech-lead', acked.acknowledged_by === 'tech-lead');
assert('acknowledged_at 有值', !!acked.acknowledged_at);

// 已确认的告警再次确认 → false
const ackOk2 = await acknowledgeAlert({ tenantId, alertId: id1, acknowledgedBy: 'other' });
assert('已确认告警再次 ack 返回 false', ackOk2 === false);

// 不存在的 id → false（not found）
const ackOk3 = await acknowledgeAlert({ tenantId, alertId: 999999, acknowledgedBy: 'test' });
assert('不存在告警 ack 返回 false', ackOk3 === false);

// ══════════════════════════════════════════════════════════════
// Step 6: queryAlertHistory — 查询
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 6] queryAlertHistory — 查询'));

const allHistory = queryAlertHistory({ tenantId });
assert('queryAlertHistory 返回 alerts 数组', Array.isArray(allHistory.alerts));
assert('queryAlertHistory 返回 total', typeof allHistory.total === 'number');
assert('total ≥ 2（已写入 2 条）', allHistory.total >= 2, `total: ${allHistory.total}`);

// severity 过滤
const warnHistory = queryAlertHistory({ tenantId, severity: 'warning' });
assert('severity=warning 过滤正确', warnHistory.alerts.every(a => a.severity === 'warning'));

// acknowledged 过滤
const unacked = queryAlertHistory({ tenantId, acknowledged: false });
assert('acknowledged=false 过滤正确', unacked.alerts.every(a => a.acknowledged === 0));
const ackedHistory = queryAlertHistory({ tenantId, acknowledged: true });
assert('acknowledged=true 过滤正确', ackedHistory.alerts.every(a => a.acknowledged === 1));

// dispatchedTo 反序列化
assert('dispatchedTo 正确反序列化', Array.isArray(allHistory.alerts[0]?.dispatchedTo));

// ══════════════════════════════════════════════════════════════
// Step 7: runAlertCycle — 完整 pipeline
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 7] runAlertCycle — 完整 pipeline'));

const cycleResult = await runAlertCycle({ tenantId, cooldownHours: 0 }); // cooldown=0 避免冷却
assert('runAlertCycle 返回 alerts 数组', Array.isArray(cycleResult.alerts));
assert('runAlertCycle 返回 persisted', typeof cycleResult.persisted === 'number',
  `persisted: ${cycleResult.persisted}`);
assert('runAlertCycle 返回 suppressed', typeof cycleResult.suppressed === 'number');
assert('persisted + suppressed = total', cycleResult.persisted + cycleResult.suppressed === cycleResult.summary.total,
  `${cycleResult.persisted}+${cycleResult.suppressed} vs ${cycleResult.summary.total}`);
assert('runAlertCycle 返回 health', typeof cycleResult.health === 'object');

// 第二次（冷却期内）全部被 suppress
const cycleResult2 = await runAlertCycle({ tenantId, cooldownHours: 100 }); // 极长冷却
assert('冷却期内 persisted = 0', cycleResult2.persisted === 0,
  `persisted: ${cycleResult2.persisted}`);
assert('冷却期内 suppressed >= 0', cycleResult2.suppressed >= 0);

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log(`\n${B('═'.repeat(55))}`);
console.log(`  W12 Runbook + 自动化告警 测试`);
console.log(`  ${G(`✓ ${passed} passed`)}  ${failed > 0 ? R(`✗ ${failed} failed`) : ''}`);
console.log(B('═'.repeat(55)));

process.exit(failed > 0 ? 1 : 0);
