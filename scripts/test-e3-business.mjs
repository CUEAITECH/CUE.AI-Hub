/**
 * E3 业务测试 — Block/Escalate review → 修复任务真实出现在任务板
 *
 * 测试目标：
 *   handleReviewOutcome 接受 updateStore 作为参数，可以完全用内存 store 测试。
 *   验证修复任务的完整业务语义，而不只是函数返回值。
 */
import assert from 'node:assert/strict';
import { handleReviewOutcome } from '../server/services/reviewTaskLinker.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(() => { console.log(`  ✅ ${name}`); passed++; })
              .catch((err) => { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; });
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}\n     ${err.message}`);
    failed++;
  }
}

function createMemoryStore(initialTasks = []) {
  let snapshot = { tasks: initialTasks.map((t) => ({ ...t })) };
  async function updateStore(mutator) {
    const draft = JSON.parse(JSON.stringify(snapshot));
    snapshot = mutator(draft) || draft;
    return snapshot;
  }
  function getSnapshot() { return JSON.parse(JSON.stringify(snapshot)); }
  return { updateStore, getSnapshot };
}

console.log('\nE3 业务测试 — Block/Escalate review → 修复任务出现在任务板\n');

await test('Block review → 任务板出现 type=fix 的修复任务', async () => {
  const { updateStore, getSnapshot } = createMemoryStore([
    { id: 'task_orig', title: '原始任务', status: 'pending', owner: '林世棋', projectId: 'proj_1' }
  ]);

  const { fixTaskId } = await handleReviewOutcome(
    { id: 'rev_001', level: 'Block', suggestion: 'SQL 注入风险，user_id 未过滤直接拼接', taskId: 'task_orig' },
    updateStore
  );

  const { tasks } = getSnapshot();
  const fixTask = tasks.find((t) => t.id === fixTaskId);

  assert.ok(fixTask, '修复任务应存在于 tasks 中');
  assert.equal(fixTask.type, 'fix', 'type 应为 fix');
  assert.equal(fixTask.priority, 'P0', '修复任务优先级应为 P0');
  assert.equal(fixTask.status, 'pending', '修复任务初始状态应为 pending');
  assert.ok(fixTask.title.startsWith('修复：'), `title 应以修复：开头，实际: ${fixTask.title}`);
  assert.ok(fixTask.title.length <= 30, `title 不超过 30 字，实际: ${fixTask.title.length}`);
  assert.ok(fixTask.dependencies.includes('task_orig'), 'dependencies 应包含原始任务 ID');
  assert.equal(fixTask.sourceReview, 'rev_001', 'sourceReview 应记录来源 review ID');
});

await test('Block review → 原始任务被标记为 blocked=true', async () => {
  const { updateStore, getSnapshot } = createMemoryStore([
    { id: 'task_orig2', title: '原始任务', status: 'in_progress', owner: '田家铭' }
  ]);

  await handleReviewOutcome(
    { id: 'rev_002', level: 'Block', suggestion: '安全漏洞', taskId: 'task_orig2' },
    updateStore
  );

  const { tasks } = getSnapshot();
  const orig = tasks.find((t) => t.id === 'task_orig2');
  assert.equal(orig.blocked, true, '原始任务应被标记为 blocked');
});

await test('Escalate review → 建修复任务，但不设 blocked（严重度不同）', async () => {
  const { updateStore, getSnapshot } = createMemoryStore([
    { id: 'task_orig3', title: '原始任务', status: 'pending' }
  ]);

  const { fixTaskId } = await handleReviewOutcome(
    { id: 'rev_003', level: 'Escalate', suggestion: '严重安全问题需升级', taskId: 'task_orig3' },
    updateStore
  );

  const { tasks } = getSnapshot();
  const fixTask = tasks.find((t) => t.id === fixTaskId);
  const orig = tasks.find((t) => t.id === 'task_orig3');

  assert.ok(fixTask, 'Escalate 也应建修复任务');
  assert.ok(!orig.blocked, 'Escalate 不设 blocked（与 Block 语义不同）');
});

await test('修复任务包含完整 Task v2 字段', async () => {
  const { updateStore, getSnapshot } = createMemoryStore([
    { id: 'task_v2', title: '任务', status: 'pending', owner: '胡佳涛', milestoneId: 'm1', projectId: 'proj_1', tenantId: 'default' }
  ]);

  const { fixTaskId } = await handleReviewOutcome(
    { id: 'rev_004', level: 'Block', suggestion: '测试字段完整性', taskId: 'task_v2' },
    updateStore
  );

  const { tasks } = getSnapshot();
  const fix = tasks.find((t) => t.id === fixTaskId);

  assert.ok(Array.isArray(fix.dependencies), 'dependencies 应为数组');
  assert.ok(Array.isArray(fix.requirementRefs), 'requirementRefs 应为数组');
  assert.ok(Array.isArray(fix.evidenceRefs), 'evidenceRefs 应为数组');
  assert.equal(fix.e2Status, 'not-tested', 'e2Status 默认为 not-tested');
  assert.ok(fix.acceptance, 'acceptance 不应为空');
  assert.ok(fix.businessNote, 'businessNote 不应为空');
  assert.ok(fix.createdAt, 'createdAt 应存在');
});

await test('修复任务继承原始任务的 owner 和 milestoneId', async () => {
  const { updateStore, getSnapshot } = createMemoryStore([
    { id: 'task_inh', title: '任务', status: 'pending', owner: '罗子宽', milestoneId: 'm2', projectId: 'proj_1' }
  ]);

  const { fixTaskId } = await handleReviewOutcome(
    { id: 'rev_005', level: 'Block', suggestion: '继承测试', taskId: 'task_inh' },
    updateStore
  );

  const { tasks } = getSnapshot();
  const fix = tasks.find((t) => t.id === fixTaskId);

  assert.equal(fix.milestoneId, 'm2', '修复任务应继承原始任务的 milestoneId');
  assert.equal(fix.projectId, 'proj_1', '修复任务应继承 projectId');
});

await test('同一 review 重复触发 — 任务板不出现重复修复任务', async () => {
  const { updateStore, getSnapshot } = createMemoryStore([]);

  const review = { id: 'rev_dup', level: 'Block', suggestion: '重复测试' };
  await handleReviewOutcome(review, updateStore);
  await handleReviewOutcome(review, updateStore);
  await handleReviewOutcome(review, updateStore);

  const { tasks } = getSnapshot();
  const fixTasks = tasks.filter((t) => t.type === 'fix');
  assert.equal(fixTasks.length, 1, '重复触发不应创建多个修复任务');
});

await test('修复任务插入到任务板头部（最高可见性）', async () => {
  const { updateStore, getSnapshot } = createMemoryStore([
    { id: 'old_task1', title: '旧任务1', status: 'pending' },
    { id: 'old_task2', title: '旧任务2', status: 'pending' }
  ]);

  const { fixTaskId } = await handleReviewOutcome(
    { id: 'rev_order', level: 'Block', suggestion: '顺序测试' },
    updateStore
  );

  const { tasks } = getSnapshot();
  assert.equal(tasks[0].id, fixTaskId, '修复任务应在任务列表第一位');
});

await test('无原始任务时（无 taskId）也能建修复任务', async () => {
  const { updateStore, getSnapshot } = createMemoryStore([]);

  const { fixTaskId } = await handleReviewOutcome(
    { id: 'rev_no_task', level: 'Block', suggestion: '无关联任务的风险' },
    updateStore
  );

  const { tasks } = getSnapshot();
  const fix = tasks.find((t) => t.id === fixTaskId);
  assert.ok(fix, '即使没有 taskId 也应建修复任务');
  assert.deepEqual(fix.dependencies, [], '无关联任务时 dependencies 为空数组');
  assert.equal(fix.owner, '待认领', '无原始任务时 owner 为待认领');
});

// ── 汇总 ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} 个测试，${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
