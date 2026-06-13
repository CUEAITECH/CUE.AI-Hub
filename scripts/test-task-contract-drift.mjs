import assert from 'node:assert/strict';
import {
  buildTaskContractMarkdown,
  parseTaskContractFrontmatter,
  validateTaskContract
} from '../server/services/taskContract.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}\n     ${err.message}`);
    failed++;
  }
}

console.log('\nTask Contract Drift 只读校验测试\n');

const task = {
  id: 'task_drift_001',
  title: '校验任务契约漂移',
  owner: '田家铭',
  status: 'pending',
  priority: 'P1',
  businessNote: '负责人能看到任务契约是否和 CUE 状态一致',
  description: '提供只读 drift 检查，不写回 store',
  acceptance: '正确契约通过校验\nAC 内容变化时报告 drift',
  dependencies: ['task_contract_001'],
  requirementRefs: ['REQ-CONTRACT-001'],
  evidenceRefs: []
};

test('parseTaskContractFrontmatter reads scalar and list fields', () => {
  const markdown = buildTaskContractMarkdown(task);
  const parsed = parseTaskContractFrontmatter(markdown);
  assert.equal(parsed.id, 'task_drift_001');
  assert.equal(parsed.status, 'pending');
  assert.deepEqual(parsed.dependencies, ['task_contract_001']);
  assert.deepEqual(parsed.requirementRefs, ['REQ-CONTRACT-001']);
});

test('validateTaskContract accepts a freshly generated contract', () => {
  const markdown = buildTaskContractMarkdown(task);
  const result = validateTaskContract(task, markdown);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('validateTaskContract reports task id drift', () => {
  const markdown = buildTaskContractMarkdown({ ...task, id: 'task_other' });
  const result = validateTaskContract(task, markdown);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'id_mismatch'));
});

test('validateTaskContract reports acceptance checklist drift', () => {
  const markdown = buildTaskContractMarkdown({
    ...task,
    acceptance: '只有一条旧 AC'
  });
  const result = validateTaskContract(task, markdown);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'acceptance_mismatch'));
});

test('validateTaskContract rejects markdown without canonical source guardrail', () => {
  const markdown = buildTaskContractMarkdown(task).replace('canonical_source: cue-db', 'canonical_source: markdown');
  const result = validateTaskContract(task, markdown);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'canonical_source_missing'));
});

if (failed > 0) {
  console.error(`\n❌ ${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n✅ ${passed} passed`);
