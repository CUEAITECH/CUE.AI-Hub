import assert from 'node:assert/strict';
import { buildTaskContractMarkdown } from '../server/services/taskContract.js';

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

console.log('\nTask Contract 业务测试\n');

const task = {
  id: 'task_business_001',
  title: '浏览器验证加入课堂',
  owner: '林世棋',
  status: 'in_progress',
  priority: 'P0',
  businessNote: '学生能在浏览器里输入课堂码加入课堂',
  description: '实现 /join 页面课堂码提交和错误态展示',
  acceptance: [
    '有效课堂码进入课堂页',
    '错误课堂码停留在加入页并显示错误',
    '网络失败时显示可重试提示'
  ].join('\n'),
  dependencies: ['task_api_001'],
  requirementRefs: ['REQ-L5-001'],
  evidenceRefs: [],
  sourceDoc: 'docs/specs/SPEC-L5-browser-agent.md'
};

const markdown = buildTaskContractMarkdown(task, {
  branchName: 'feat/0604-lin-browser-join',
  projectName: 'Cue.AI',
  hubUrl: 'https://hub.cueai.top'
});

test('contract states CUE remains the canonical source of truth', () => {
  assert.ok(markdown.includes('CUE DB/store is the source of truth'), 'canonical source warning missing');
  assert.ok(markdown.includes('Do not edit status, evidenceRefs, or linked PR fields by hand'), 'write-protection warning missing');
});

test('contract is useful as an agent execution package', () => {
  assert.ok(markdown.includes('## Business Goal'), 'business goal section missing');
  assert.ok(markdown.includes('学生能在浏览器里输入课堂码加入课堂'), 'business note missing');
  assert.ok(markdown.includes('## Task Description'), 'task description section missing');
  assert.ok(markdown.includes('## Acceptance Criteria'), 'AC section missing');
  assert.ok(markdown.includes('## Execution Notes'), 'execution notes section missing');
  assert.ok(markdown.includes('## Completion Evidence'), 'completion evidence section missing');
});

test('contract preserves dependency and requirement traceability', () => {
  assert.ok(markdown.includes('- `task_api_001`'), 'dependency missing from body');
  assert.ok(markdown.includes('- `REQ-L5-001`'), 'requirement ref missing from body');
  assert.ok(markdown.includes('sourceDoc: docs/specs/SPEC-L5-browser-agent.md'), 'source doc missing from frontmatter');
});

test('contract AC checklist is ready for PR review', () => {
  const checks = markdown.split('\n').filter((line) => line.startsWith('- [ ] '));
  assert.equal(checks.length, 3);
  assert.ok(checks[0].includes('有效课堂码进入课堂页'));
  assert.ok(checks[2].includes('网络失败时显示可重试提示'));
});

test('contract tells agent how to report evidence without writing runtime state', () => {
  assert.ok(markdown.includes('Reference this task id in commits and PRs'), 'task id instruction missing');
  assert.ok(markdown.includes('Let CUE write evidenceRefs after PR creation or merge'), 'evidence writeback instruction missing');
});

if (failed > 0) {
  console.error(`\n❌ ${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n✅ ${passed} passed`);
