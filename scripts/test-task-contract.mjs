import assert from 'node:assert/strict';
import {
  buildTaskContractMarkdown,
  taskContractPath
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

console.log('\nTask Contract 单元测试\n');

const task = {
  id: 'task_contract_001',
  title: '实现学生端加入课堂',
  owner: '林世棋',
  status: 'pending',
  priority: 'P0',
  businessNote: '学生能通过课堂码加入老师的课堂',
  description: '学生端调用 join API 并进入课堂页',
  acceptance: '输入有效课堂码后进入课堂页\n无效课堂码显示错误提示',
  dependencies: ['task_sign_001', 'task_room_001'],
  requirementRefs: ['REQ-L2-001', 'REQ-L5-001'],
  evidenceRefs: ['https://github.com/acme/repo/pull/12'],
  milestoneId: 'm1',
  sourceDoc: 'docs/specs/SPEC-L2-task-schema.md'
};

test('taskContractPath keeps existing .hub/{taskId}.md compatibility', () => {
  assert.equal(taskContractPath('task_contract_001'), '.hub/task_contract_001.md');
});

test('taskContractPath sanitizes unsafe task ids', () => {
  assert.equal(taskContractPath('../task contract/001'), '.hub/task_contract_001.md');
});

test('buildTaskContractMarkdown includes stable frontmatter', () => {
  const markdown = buildTaskContractMarkdown(task, { branchName: 'feat/0604-lin-001', projectName: 'Cue.AI' });
  assert.ok(markdown.startsWith('---\n'), 'frontmatter must be first');
  assert.ok(markdown.includes('id: task_contract_001'), 'task id missing');
  assert.ok(markdown.includes('generated_by: cue-hub'), 'generated marker missing');
  assert.ok(markdown.includes('canonical_source: cue-db'), 'canonical source marker missing');
  assert.ok(markdown.includes('status: pending'), 'status missing');
  assert.ok(markdown.includes('milestoneId: m1'), 'milestone missing');
  assert.ok(markdown.includes('dependencies:'), 'dependencies key missing');
  assert.ok(markdown.includes('  - task_sign_001'), 'dependency item missing');
  assert.ok(markdown.includes('requirementRefs:'), 'requirement refs missing');
  assert.ok(markdown.includes('evidenceRefs:'), 'evidence refs missing');
});

test('buildTaskContractMarkdown converts acceptance text into checkbox items', () => {
  const markdown = buildTaskContractMarkdown(task);
  assert.ok(markdown.includes('- [ ] 输入有效课堂码后进入课堂页'), 'first AC checkbox missing');
  assert.ok(markdown.includes('- [ ] 无效课堂码显示错误提示'), 'second AC checkbox missing');
});

test('buildTaskContractMarkdown never emits undefined or null literals', () => {
  const markdown = buildTaskContractMarkdown({ id: 'task_empty', title: '空任务' });
  assert.equal(markdown.includes('undefined'), false);
  assert.equal(markdown.includes('null'), false);
});

if (failed > 0) {
  console.error(`\n❌ ${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n✅ ${passed} passed`);
