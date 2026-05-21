/**
 * test-w14-autonomy.mjs
 * W14: 渐进式自主权系统测试
 * 运行：LLM_DRY_RUN=true node scripts/test-w14-autonomy.mjs
 */

import { initDb, getDb } from '../server/db/index.js';
import {
  ensureAutonomyTables,
  getAutonomyLevel,
  getAutonomyHistory,
  listAutonomyLevels,
  adjustAutonomy,
  evaluateAutonomy,
  autoAdjustAll,
  canPerform,
  AUTONOMY_LEVELS,
} from '../server/services/autonomy.js';
import { dbWrite } from '../server/db/actor.js';

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
const tenantId = `test_w14_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
ensureAutonomyTables();
const db = getDb();
const projectId = `proj_w14_${tenantId.slice(-8)}`;

// 辅助：创建 actor（使用 v2.db actors 表真实 schema）
function createActor(id, displayName, type = 'ai-agent') {
  db.prepare(`INSERT OR IGNORE INTO actors (id, tenant_id, type, display_name, active) VALUES (?,?,?,?,1)`)
    .run(id, tenantId, type, displayName);
}

// 辅助：插入 outcomes（ai_outcomes 表已存在于 v2.db）
function insertOutcomes(actorId, polarities) {
  for (const p of polarities) {
    db.prepare(`
      INSERT INTO ai_outcomes (tenant_id, action_type, action_ref_id, outcome_signal, polarity, observer, observed_at)
      VALUES (?, 'task', ?, 'test', ?, ?, ?)
    `).run(tenantId, `task_${Math.random().toString(36).slice(2)}`, p, actorId, new Date().toISOString());
  }
}

// 辅助：插入 tasks（for stuck task check）
function insertStuckTask(actorId) {
  const taskId = `task_stuck_${Math.random().toString(36).slice(2)}`;
  const oldTime = new Date(Date.now() - 80 * 3600 * 1000).toISOString(); // 80h ago
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, actor_id, state, updated_at, title, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(taskId, tenantId, projectId, actorId, 'in_progress', oldTime, 'stuck task', oldTime);
  return taskId;
}

// 辅助：插入 reviews（通过 task 关联 actor）
function insertReviews(actorId, levels) {
  for (const level of levels) {
    // 先创建关联任务
    const taskId = `task_rev_${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, actor_id, state, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(taskId, tenantId, projectId, actorId, 'in_review', 'review task', now, now);
    // 创建 review
    db.prepare(`INSERT INTO reviews (tenant_id, task_id, level, source, created_at) VALUES (?,?,?,?,?)`)
      .run(tenantId, taskId, level, 'ai-agent', now);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
console.log('  W14 渐进式自主权系统 测试');
console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');

// ─── Step 1: AUTONOMY_LEVELS 常量 ────────────────────────────────────────────
section('Step 1: AUTONOMY_LEVELS 常量');

assert(Object.keys(AUTONOMY_LEVELS).length === 5, '有 5 个等级定义');
assert(AUTONOMY_LEVELS[1].name === 'Supervised', '1 级 = Supervised');
assert(AUTONOMY_LEVELS[5].name === 'Fully Auto', '5 级 = Fully Auto');
assert(AUTONOMY_LEVELS[3].color === 'yellow', '3 级 color = yellow');

// ─── Step 2: getAutonomyLevel 默认值 ─────────────────────────────────────────
section('Step 2: getAutonomyLevel 默认值');

const agentId = `agent_w14_${tenantId.slice(-8)}`;
createActor(agentId, 'TestAgent');

const defaultLevel = getAutonomyLevel({ tenantId, actorId: agentId });
assertEq(defaultLevel.level, 1, '未设置时默认 1 级');
assertEq(defaultLevel.levelName, 'Supervised', '默认 levelName = Supervised');
assert(defaultLevel.changedAt === null, '未设置时 changedAt = null');

// ─── Step 3: adjustAutonomy 手动升级 ─────────────────────────────────────────
section('Step 3: adjustAutonomy 手动升级');

const adj1 = await adjustAutonomy({
  tenantId, actorId: agentId,
  newLevel: 3, reason: '手动测试升级', changedBy: 'tester',
});
assertEq(adj1.newLevel, 3, 'adjustAutonomy 返回 newLevel=3');
assertEq(adj1.oldLevel, null, '初次设置 oldLevel=null');
assertEq(adj1.direction, 'initialized', '初次方向 = initialized');

const afterAdj = getAutonomyLevel({ tenantId, actorId: agentId });
assertEq(afterAdj.level, 3, '读取后 level=3');
assertEq(afterAdj.reason, '手动测试升级', 'reason 写入正确');

// 再次降级
const adj2 = await adjustAutonomy({
  tenantId, actorId: agentId,
  newLevel: 2, reason: '测试降级',
});
assertEq(adj2.oldLevel, 3, 'oldLevel 正确记录之前的级别');
assertEq(adj2.direction, 'demoted', 'direction = demoted');

// ─── Step 4: autonomy_history 记录 ───────────────────────────────────────────
section('Step 4: autonomy_history 记录');

const history = getAutonomyHistory({ tenantId, actorId: agentId, limit: 10 });
assert(history.length >= 2, '历史记录 ≥ 2 条');
assertEq(history[0].new_level, 2, '最新历史 new_level=2');
assertEq(history[0].old_level, 3, '最新历史 old_level=3');
assert(history[0].reason === '测试降级', '历史记录包含 reason');

// ─── Step 5: listAutonomyLevels ───────────────────────────────────────────────
section('Step 5: listAutonomyLevels');

const agentId2 = `agent2_w14_${tenantId.slice(-8)}`;
createActor(agentId2, 'TestAgent2');

const levels = listAutonomyLevels({ tenantId });
assert(levels.length >= 2, 'listAutonomyLevels 返回 ≥ 2 个 agent');
const found = levels.find(l => l.actorId === agentId);
assert(found !== undefined, '能找到 agentId');
assertEq(found.level, 2, 'agentId 当前级别 = 2');
assertEq(found.levelName, 'Assisted', 'levelName = Assisted');

// ─── Step 6: evaluateAutonomy — 升级场景 ──────────────────────────────────────
section('Step 6: evaluateAutonomy — 升级场景（1→2）');

const promotableId = `agent_promote_${tenantId.slice(-8)}`;
createActor(promotableId, 'PromotableAgent');
// 10 个成功任务 → 满足 1→2 升级条件
insertOutcomes(promotableId, Array(10).fill(1));

const evalPromote = evaluateAutonomy({ tenantId, actorId: promotableId });
assertEq(evalPromote.currentLevel, 1, '当前 1 级');
assertEq(evalPromote.recommendation, 'promote', '推荐升级');
assertEq(evalPromote.newLevel, 2, '推荐升至 2 级');
assert(evalPromote.metrics.successRate10 >= 80, 'successRate10 ≥ 80%');
assert(evalPromote.reason.includes('成功率'), 'reason 含成功率信息');

// ─── Step 7: evaluateAutonomy — 降级场景（successRate < 60%）───────────────────
section('Step 7: evaluateAutonomy — 降级场景（低成功率）');

const demotableId = `agent_demote_${tenantId.slice(-8)}`;
createActor(demotableId, 'DemotableAgent');
// 先设置为 3 级
await adjustAutonomy({ tenantId, actorId: demotableId, newLevel: 3, reason: '初始' });
// 插入 8 个失败 + 2 个成功 = 20% 成功率
insertOutcomes(demotableId, [...Array(8).fill(-1), ...Array(2).fill(1)]);

const evalDemote = evaluateAutonomy({ tenantId, actorId: demotableId });
assertEq(evalDemote.currentLevel, 3, '当前 3 级');
assertEq(evalDemote.recommendation, 'demote', '推荐降级');
assertEq(evalDemote.newLevel, 1, '直接降至 1 级（低于 60% 警戒线）');
assert(evalDemote.metrics.successRate10 < 60, 'successRate10 < 60%');

// ─── Step 8: evaluateAutonomy — 降级场景（连续 Block review）─────────────────
section('Step 8: evaluateAutonomy — 降级场景（连续 Block）');

const blockId = `agent_block_${tenantId.slice(-8)}`;
createActor(blockId, 'BlockAgent');
await adjustAutonomy({ tenantId, actorId: blockId, newLevel: 3, reason: '初始' });
// 2 次连续 Block review
insertReviews(blockId, ['Block', 'Block']);

const evalBlock = evaluateAutonomy({ tenantId, actorId: blockId });
assertEq(evalBlock.recommendation, 'demote', '连续 Block → 降级');
assertEq(evalBlock.newLevel, 2, '从 3 降到 2');
assertEq(evalBlock.metrics.consecutiveBlocks, 2, 'consecutiveBlocks = 2');

// ─── Step 9: evaluateAutonomy — 降级场景（卡住任务）──────────────────────────
section('Step 9: evaluateAutonomy — 降级场景（卡住任务）');

const stuckId = `agent_stuck_${tenantId.slice(-8)}`;
createActor(stuckId, 'StuckAgent');
await adjustAutonomy({ tenantId, actorId: stuckId, newLevel: 4, reason: '初始' });
insertStuckTask(stuckId);

const evalStuck = evaluateAutonomy({ tenantId, actorId: stuckId });
assertEq(evalStuck.recommendation, 'demote', '卡住任务 → 降级');
assertEq(evalStuck.newLevel, 3, '从 4 降到 3');
assertEq(evalStuck.metrics.stuckTasks, 1, 'stuckTasks = 1');

// ─── Step 10: evaluateAutonomy — 维持场景 ────────────────────────────────────
section('Step 10: evaluateAutonomy — 维持场景');

const stableId = `agent_stable_${tenantId.slice(-8)}`;
createActor(stableId, 'StableAgent');
await adjustAutonomy({ tenantId, actorId: stableId, newLevel: 3, reason: '初始' });
// 插入 5 个成功（不足 10 个不触发升级）
insertOutcomes(stableId, Array(5).fill(1));

const evalStable = evaluateAutonomy({ tenantId, actorId: stableId });
assertEq(evalStable.recommendation, 'maintain', '数据不足时维持');
assertEq(evalStable.newLevel, 3, '级别不变');

// ─── Step 11: autoAdjustAll dryRun ───────────────────────────────────────────
section('Step 11: autoAdjustAll dryRun=true');

const dryResult = await autoAdjustAll({ tenantId, dryRun: true });
assert(dryResult.evaluated >= 0, '返回 evaluated 字段');
assert(typeof dryResult.promoted === 'number', '有 promoted 计数');
assert(typeof dryResult.demoted === 'number', '有 demoted 计数');
assert(dryResult.dryRun === true, 'dryRun=true 标记正确');
assert(Array.isArray(dryResult.results), 'results 是数组');
// dryRun 不实际写入
for (const r of dryResult.results) {
  assert(r.applied === false, `dryRun 下 ${r.actorName} applied=false`);
}

// ─── Step 12: autoAdjustAll 实际执行 ─────────────────────────────────────────
section('Step 12: autoAdjustAll 实际执行');

// 准备一个必然升级的 agent
const autoId = `agent_auto_${tenantId.slice(-8)}`;
createActor(autoId, 'AutoAgent');
// 1 级 + 10 成功 → 应升至 2 级
insertOutcomes(autoId, Array(10).fill(1));

const liveResult = await autoAdjustAll({ tenantId, dryRun: false });
assert(liveResult.evaluated >= 1, '至少评估 1 个 agent');
assert(liveResult.dryRun === false, 'dryRun=false');

// 验证 autoId 已升级
const afterAuto = getAutonomyLevel({ tenantId, actorId: autoId });
assertEq(afterAuto.level, 2, 'autoAdjustAll 后 autoId 升至 2 级');

// ─── Step 13: canPerform 权限矩阵 ─────────────────────────────────────────────
section('Step 13: canPerform 权限矩阵');

// 创建不同级别的 agent 测试权限
const perm1 = `perm1_${tenantId.slice(-8)}`;
const perm3 = `perm3_${tenantId.slice(-8)}`;
const perm5 = `perm5_${tenantId.slice(-8)}`;
createActor(perm1, 'Perm1'); // 默认 1 级（未设置）
await adjustAutonomy({ tenantId, actorId: perm3, newLevel: 3, reason: '测试' });
await adjustAutonomy({ tenantId, actorId: perm5, newLevel: 5, reason: '测试' });

// 注意：perm3/perm5 不需要在 actors 表存在（canPerform 只读 actor_autonomy）
// 但 getAutonomyLevel 需要能读到，不需要 actors 表

assert(canPerform({ tenantId, actorId: perm1, action: 'read' }), '1 级可 read');
assert(!canPerform({ tenantId, actorId: perm1, action: 'execute_routine' }), '1 级不可 execute_routine');
assert(!canPerform({ tenantId, actorId: perm1, action: 'admin' }), '1 级不可 admin');

assert(canPerform({ tenantId, actorId: perm3, action: 'read' }), '3 级可 read');
assert(canPerform({ tenantId, actorId: perm3, action: 'execute_routine' }), '3 级可 execute_routine');
assert(canPerform({ tenantId, actorId: perm3, action: 'execute_complex' }), '3 级可 execute_complex');
assert(!canPerform({ tenantId, actorId: perm3, action: 'escalate' }), '3 级不可 escalate');
assert(!canPerform({ tenantId, actorId: perm3, action: 'admin' }), '3 级不可 admin');

assert(canPerform({ tenantId, actorId: perm5, action: 'admin' }), '5 级可 admin');
assert(canPerform({ tenantId, actorId: perm5, action: 'escalate' }), '5 级可 escalate');

// ─── Step 14: adjustAutonomy 边界检查 ────────────────────────────────────────
section('Step 14: adjustAutonomy 边界检查');

let errorThrown = false;
try {
  await adjustAutonomy({ tenantId, actorId: agentId, newLevel: 6, reason: '超出范围' });
} catch (e) {
  errorThrown = true;
  assert(e.message.includes('1-5'), '错误信息提示范围 1-5');
}
assert(errorThrown, '级别 6 抛出异常');

errorThrown = false;
try {
  await adjustAutonomy({ tenantId, actorId: agentId, newLevel: 0, reason: '超出范围' });
} catch (e) {
  errorThrown = true;
}
assert(errorThrown, '级别 0 抛出异常');

// ─── Step 15: 高级升级路径（2→3）──────────────────────────────────────────────
section('Step 15: 高级升级路径（2→3）');

const seniorId = `agent_senior_${tenantId.slice(-8)}`;
createActor(seniorId, 'SeniorAgent');
await adjustAutonomy({ tenantId, actorId: seniorId, newLevel: 2, reason: '初始' });
// 20 个成功任务 + 无 Block → 满足 2→3
insertOutcomes(seniorId, Array(20).fill(1));

const evalSenior = evaluateAutonomy({ tenantId, actorId: seniorId });
assertEq(evalSenior.currentLevel, 2, '当前 2 级');
assertEq(evalSenior.recommendation, 'promote', '推荐升级');
assertEq(evalSenior.newLevel, 3, '推荐升至 3 级');
assert(evalSenior.metrics.successRate20 >= 85, 'successRate20 ≥ 85%');

// ─── Step 16: 升级后有新历史记录 ──────────────────────────────────────────────
section('Step 16: adjustAutonomy direction=manual 写历史');

const histId = `agent_hist_${tenantId.slice(-8)}`;
createActor(histId, 'HistAgent');
await adjustAutonomy({ tenantId, actorId: histId, newLevel: 1, reason: '初始设置', direction: 'initialized' });
await adjustAutonomy({ tenantId, actorId: histId, newLevel: 3, reason: '手动提升', changedBy: 'admin', direction: 'manual' });

const hist = getAutonomyHistory({ tenantId, actorId: histId });
assertEq(hist.length, 2, '历史有 2 条记录');
assertEq(hist[0].direction, 'manual', '最新记录 direction=manual');
assertEq(hist[0].changed_by, 'admin', 'changed_by=admin');
assertEq(hist[1].direction, 'initialized', '初始化记录');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
console.log('  W14 渐进式自主权系统 测试');
if (failed === 0) {
  console.log(`  \x1b[32m✓ ${passed} passed\x1b[0m  `);
} else {
  console.log(`  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m`);
}
console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m\n');

process.exit(failed > 0 ? 1 : 0);
