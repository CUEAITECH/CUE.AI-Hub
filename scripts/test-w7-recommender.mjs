/**
 * scripts/test-w7-recommender.mjs
 * W7 集成测试 — 三阶段推荐管道
 *
 * 测试内容：
 *   1. 特征提取（skillMatch 评分）
 *   2. 排名器（评分维度）
 *   3. 推荐过滤（minScore）
 *   4. 全流程 recommendForTask（LLM_DRY_RUN 规则解释）
 *   5. batchRecommend（多任务）
 *   6. agent-only 过滤
 *   7. 高负载 actor 得分低
 */

import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import { recommendForTask, batchRecommend } from '../server/services/recommender.js';

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
const tenantId = `test_w7_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();

// ── 基础数据 ─────────────────────────────────────────────────
const projectId = `proj_w7_${Date.now()}`;
db.prepare(`INSERT INTO projects (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, 'W7 Test', ?, ?)`)
  .run(projectId, tenantId, now(), now());

// 创建 actors：2 human + 2 agent，不同能力和负载
await dbWrite('test:w7.actors', (db) => {
  // 人类：代码专家，无负载
  db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'human', '张三（代码专家）', '["code","review","api"]', 0, 1, ?, ?)`)
    .run(`h1_${tenantId}`, tenantId, now(), now());

  // 人类：设计师，高负载
  db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'human', '李四（设计师）', '["design","ui","ux"]', 0, 1, ?, ?)`)
    .run(`h2_${tenantId}`, tenantId, now(), now());

  // AI agent：全能，中等自主度
  db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', 'CodeAgent', '["code","test","review","api","database"]', 3, 1, ?, ?)`)
    .run(`a1_${tenantId}`, tenantId, now(), now());

  // AI agent：DevOps 专向，高自主度
  db.prepare(`INSERT INTO actors (id, tenant_id, type, display_name, capabilities_json, autonomy_level, active, created_at, updated_at)
    VALUES (?, ?, 'ai-agent', 'DevOpsAgent', '["devops","security","database"]', 5, 1, ?, ?)`)
    .run(`a2_${tenantId}`, tenantId, now(), now());
});

// 给李四加 3 个进行中的任务（模拟高负载）
await dbWrite('test:w7.tasks.load', (db) => {
  for (let i = 0; i < 3; i++) {
    db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, actor_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'in_progress', 'P2', 50, ?, ?, ?)`)
      .run(`load_task_${i}_${tenantId}`, tenantId, projectId, `设计任务${i}`, `h2_${tenantId}`, now(), now());
  }
});

// 目标任务：代码相关
const taskId = `task_w7_code_${Date.now()}`;
await dbWrite('test:w7.task', (db) => {
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, acceptance, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 'P1', 0, ?, ?)`)
    .run(taskId, tenantId, projectId,
      '实现 RESTful API 接口',
      '- 接口符合 REST 规范\n- 有完整的单元测试\n- API 文档完整',
      now(), now());
});

// ══════════════════════════════════════════════════════════════
// Step 1: 全流程推荐（规则解释）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 1] recommendForTask — 完整三阶段'));

const result = await recommendForTask({
  taskId,
  tenantId,
  options: { topK: 5, explain: true },
});

assert('返回 taskId', result.taskId === taskId);
assert('返回 recommendations 数组', Array.isArray(result.recommendations));
assert('推荐结果非空', result.recommendations.length > 0,
  `got ${result.recommendations.length}`);
assert('返回 stats', typeof result.stats === 'object');
assert('stats.totalCandidates = 4', result.stats.totalCandidates === 4,
  `got ${result.stats.totalCandidates}`);

const top = result.recommendations[0];
assert('top 推荐有 actorId', !!top?.actorId);
assert('top 推荐有 score', typeof top?.score === 'number');
assert('top 推荐有 scoreBreakdown', typeof top?.scoreBreakdown === 'object');
assert('top 推荐有 reason', typeof top?.reason === 'string' && top.reason.length > 0);
assert('top 推荐有 capabilities', Array.isArray(top?.capabilities));
assert('top 推荐有 currentLoad', typeof top?.currentLoad === 'number');
assert('top 推荐有 skillMatch（0-100）', top?.skillMatch >= 0 && top?.skillMatch <= 100);

console.log(`  top推荐: ${top?.displayName} (${top?.type}) score=${top?.score}`);
console.log(`  reason: ${top?.reason?.slice(0, 60)}`);

// ══════════════════════════════════════════════════════════════
// Step 2: 代码任务 → 代码 actor 排名靠前
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 2] 技能匹配排名'));

// 代码任务 → 张三（code/api）和 CodeAgent（code/test/api）应该排在前面
// 设计师（design/ui/ux）应该排在后面
const codeActors = result.recommendations.filter(r => r.capabilities.includes('code'));
const designActor = result.recommendations.find(r => r.actorId === `h2_${tenantId}`);

assert('有代码能力的 actor 出现在推荐中', codeActors.length > 0);
if (designActor) {
  const designIdx = result.recommendations.indexOf(designActor);
  const maxCodeIdx = Math.max(...codeActors.map(c => result.recommendations.indexOf(c)));
  assert('设计师（无代码技能）排名低于代码专家', designIdx > maxCodeIdx,
    `设计师排名 ${designIdx}，最高代码 actor 排名 ${maxCodeIdx}`);
}

// ══════════════════════════════════════════════════════════════
// Step 3: 高负载 actor 得分低
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 3] 负载惩罚'));

const designerRec = result.recommendations.find(r => r.actorId === `h2_${tenantId}`);
const codeExpertRec = result.recommendations.find(r => r.actorId === `h1_${tenantId}`);

if (designerRec && codeExpertRec) {
  // 即使技能不匹配，负载低的张三的 load 分应该高于负载满的李四
  assert('高负载（3任务）得分 < 低负载（0任务）',
    designerRec.score < codeExpertRec.score,
    `设计师 ${designerRec.score} vs 代码专家 ${codeExpertRec.score}`);
  assert('设计师当前负载 = 3', designerRec.currentLoad === 3,
    `got ${designerRec.currentLoad}`);
}

// ══════════════════════════════════════════════════════════════
// Step 4: actorType 过滤 — 只推荐 agent
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 4] actorType=ai-agent 过滤'));

const agentOnly = await recommendForTask({
  taskId,
  tenantId,
  options: { actorType: 'ai-agent', explain: false },
});

assert('只返回 ai-agent', agentOnly.recommendations.every(r => r.type === 'ai-agent'));
assert('agent 推荐 ≤ 2 个（总共有 2 个 agent）', agentOnly.recommendations.length <= 2);

const codeAgent = agentOnly.recommendations.find(r => r.actorId === `a1_${tenantId}`);
assert('CodeAgent 在 agent-only 推荐中', !!codeAgent);

// ══════════════════════════════════════════════════════════════
// Step 5: minScore 过滤
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 5] minScore 过滤'));

const highThreshold = await recommendForTask({
  taskId,
  tenantId,
  options: { minScore: 80, explain: false },
});

assert('所有推荐得分 ≥ 80', highThreshold.recommendations.every(r => r.score >= 80),
  `scores: ${highThreshold.recommendations.map(r => r.score).join(',')}`);

// ══════════════════════════════════════════════════════════════
// Step 6: batchRecommend — 多任务批量
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 6] batchRecommend 批量推荐'));

// 再加两个 pending 任务
await dbWrite('test:w7.batch', (db) => {
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, '部署 CI/CD 流水线', 'pending', 'P2', 0, ?, ?)`)
    .run(`task_w7_devops_${Date.now()}`, tenantId, projectId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, '设计数据库 schema', 'pending', 'P2', 0, ?, ?)`)
    .run(`task_w7_db_${Date.now()}`, tenantId, projectId, now(), now());
});

const batch = await batchRecommend({
  tenantId,
  projectId,
  options: { minScore: 10 },
});

assert('batchRecommend 返回 results 数组', Array.isArray(batch.results));
assert('batchRecommend 评估了 3 个任务', batch.stats.tasksEvaluated === 3,
  `got ${batch.stats.tasksEvaluated}`);
assert('部分任务有推荐结果', batch.stats.withRecommendations >= 1,
  `got ${batch.stats.withRecommendations}`);

// ══════════════════════════════════════════════════════════════
// Step 7: scoreBreakdown 验证
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 7] scoreBreakdown 完整性'));

assert('breakdown 包含 skill 维度', typeof top?.scoreBreakdown?.skill === 'number');
assert('breakdown 包含 load 维度', typeof top?.scoreBreakdown?.load === 'number');
assert('breakdown 包含 success 维度', typeof top?.scoreBreakdown?.success === 'number');
assert('breakdown 各维度之和 ≤ 100', (() => {
  const b = top?.scoreBreakdown;
  const sum = (b?.skill || 0) + (b?.load || 0) + (b?.success || 0) + (b?.freshness || 0) + (b?.autonomy || 0);
  return sum <= 100;
})());

// ══════════════════════════════════════════════════════════════
// Step 8: 任务不存在时抛错
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 8] 错误处理'));

try {
  await recommendForTask({ taskId: 'nonexistent_task', tenantId });
  assert('不存在任务应抛出错误', false);
} catch (err) {
  assert('不存在任务抛出正确错误', err.message.includes('not found'));
}

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log(`\n${B('═'.repeat(55))}`);
console.log(`  W7 推荐三阶段管道 测试`);
console.log(`  ${G(`✓ ${passed} passed`)}  ${failed > 0 ? R(`✗ ${failed} failed`) : ''}`);
console.log(B('═'.repeat(55)));

process.exit(failed > 0 ? 1 : 0);
