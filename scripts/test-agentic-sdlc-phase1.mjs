/**
 * Agentic SDLC Phase 1 单元测试
 * 运行：node scripts/test-agentic-sdlc-phase1.mjs
 */
import assert from 'node:assert/strict';
import { migrateStore } from '../server/store.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

// ─── Task 1: migrateStore 新字段 ───────────────────────────────────────────

console.log('\nTask 1: migrateStore — Task v2 新字段\n');

test('migrateStore({}) 包含 milestones 数组', () => {
  const result = migrateStore({});
  assert.ok(Array.isArray(result.milestones), `milestones 应为数组，实际: ${typeof result.milestones}`);
});

test('migrateStore({}) 包含 prds 数组', () => {
  const result = migrateStore({});
  assert.ok(Array.isArray(result.prds), `prds 应为数组，实际: ${typeof result.prds}`);
});

test('migrateStore({}) 包含 testRuns 数组', () => {
  const result = migrateStore({});
  assert.ok(Array.isArray(result.testRuns), `testRuns 应为数组，实际: ${typeof result.testRuns}`);
});

test('migrateStore({}) 包含 gapAnalysis 空对象', () => {
  const result = migrateStore({});
  assert.deepEqual(result.gapAnalysis, {}, `gapAnalysis 应为 {}，实际: ${JSON.stringify(result.gapAnalysis)}`);
});

test('migrateStore({}) 包含 manualTestQueue 数组', () => {
  const result = migrateStore({});
  assert.ok(Array.isArray(result.manualTestQueue), `manualTestQueue 应为数组，实际: ${typeof result.manualTestQueue}`);
});

test('已有 milestones 的 store 不被覆盖', () => {
  const result = migrateStore({ milestones: [{ id: 'm1', title: '测试里程碑' }] });
  assert.equal(result.milestones.length, 1, '已有 milestones 不应被清空');
  assert.equal(result.milestones[0].id, 'm1');
});

test('旧 task acceptance===description 被清空', () => {
  const store = {
    tasks: [{ id: 'task_001', title: '旧任务', description: '旧描述', acceptance: '旧描述' }]
  };
  const result = migrateStore(store);
  const task = result.tasks.find((t) => t.id === 'task_001');
  assert.equal(task.acceptance, '', `acceptance===description 应被清空，实际: "${task.acceptance}"`);
});

test('正常 acceptance 不被清空', () => {
  const store = {
    tasks: [{ id: 'task_002', title: '正常任务', description: '技术描述', acceptance: '可测量的完成条件' }]
  };
  const result = migrateStore(store);
  const task = result.tasks.find((t) => t.id === 'task_002');
  assert.equal(task.acceptance, '可测量的完成条件', '正常 acceptance 不应被改动');
});

test('旧 task 补全 businessNote 字段', () => {
  const store = { tasks: [{ id: 'task_003', title: '旧任务' }] };
  const result = migrateStore(store);
  const task = result.tasks.find((t) => t.id === 'task_003');
  assert.ok('businessNote' in task, 'businessNote 字段应存在');
  assert.equal(task.businessNote, '', 'businessNote 默认值应为空字符串');
});

test('旧 task 补全 dependencies 数组', () => {
  const store = { tasks: [{ id: 'task_004', title: '旧任务' }] };
  const result = migrateStore(store);
  const task = result.tasks.find((t) => t.id === 'task_004');
  assert.ok(Array.isArray(task.dependencies), 'dependencies 应为数组');
});

test('旧 task 补全 evidenceRefs 数组', () => {
  const store = { tasks: [{ id: 'task_005', title: '旧任务' }] };
  const result = migrateStore(store);
  const task = result.tasks.find((t) => t.id === 'task_005');
  assert.ok(Array.isArray(task.evidenceRefs), 'evidenceRefs 应为数组');
});

test('旧 task 补全 e2Status 字段', () => {
  const store = { tasks: [{ id: 'task_006', title: '旧任务' }] };
  const result = migrateStore(store);
  const task = result.tasks.find((t) => t.id === 'task_006');
  assert.equal(task.e2Status, 'not-tested', 'e2Status 默认值应为 not-tested');
});

test('已有 e2Status 的 task 不被覆盖', () => {
  const store = { tasks: [{ id: 'task_007', title: '任务', e2Status: 'verified' }] };
  const result = migrateStore(store);
  const task = result.tasks.find((t) => t.id === 'task_007');
  assert.equal(task.e2Status, 'verified', '已有 e2Status 不应被覆盖');
});

// ─── 结果汇总 ──────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} 个测试，${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
