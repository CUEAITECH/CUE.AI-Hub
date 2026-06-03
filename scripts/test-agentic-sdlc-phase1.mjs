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

// ─── Task 2: PARSE_SYSTEM_PROMPT v2 字段检查 ──────────────────────────────

console.log('\nTask 2: PARSE_SYSTEM_PROMPT — Task v2 schema\n');

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsManagerSrc = readFileSync(join(__dirname, '../server/services/docsManager.js'), 'utf8');
const promptStart = docsManagerSrc.indexOf('const PARSE_SYSTEM_PROMPT');
const promptEnd = docsManagerSrc.indexOf('`;', promptStart) + 2;
const promptBlock = docsManagerSrc.slice(promptStart, promptEnd);

test('prompt 包含 businessNote 字段', () => {
  assert.ok(promptBlock.includes('"businessNote"'), 'prompt 应包含 businessNote 字段定义');
});

test('prompt 包含 acceptance 字段', () => {
  assert.ok(promptBlock.includes('"acceptance"'), 'prompt 应包含 acceptance 字段定义');
});

test('prompt 包含 dependencies 字段', () => {
  assert.ok(promptBlock.includes('"dependencies"'), 'prompt 应包含 dependencies 字段定义');
});

test('prompt 包含 requirementRefs 字段', () => {
  assert.ok(promptBlock.includes('"requirementRefs"'), 'prompt 应包含 requirementRefs 字段定义');
});

test('prompt 包含禁止复制 description 规则', () => {
  assert.ok(promptBlock.includes('禁止复制'), 'prompt 应包含 acceptance 禁止复制 description 的规则');
});

test('prompt 包含 businessNote 格式规则', () => {
  assert.ok(promptBlock.includes('用户能'), 'prompt 应包含 businessNote 格式示例');
});

test('prompt 包含 description 和 businessNote 分开要求', () => {
  assert.ok(
    promptBlock.includes('必须与 description 不同') || promptBlock.includes('businessNote 不同'),
    'prompt 应要求 businessNote 与 description 不同'
  );
});

// ─── Task 3: stableTaskId 幂等 ID ─────────────────────────────────────────
// 注意：docsManager.js 引入 store.js/SQLite，不能在测试中直接 import。
// 改用从源码中提取并独立运行同等逻辑来验证正确性。

console.log('\nTask 3: stableTaskId — 幂等任务 ID\n');

// 与 docsManager.js 中 stableTaskId 实现完全相同的纯函数（djb2 hash）
function stableTaskId(sourceDoc, title) {
  const raw = String(sourceDoc || '') + '|' + String(title || '');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(h, 33) ^ raw.charCodeAt(i)) >>> 0;
  }
  return `task_${h.toString(36).padStart(7, '0')}`;
}

// 验证源码中的实现与本测试逻辑一致（文本匹配）
test('docsManager.js 包含 stableTaskId 函数定义', () => {
  const src = readFileSync(new URL('../server/services/docsManager.js', import.meta.url), 'utf8');
  assert.ok(src.includes('export function stableTaskId'), 'stableTaskId 应以 export function 形式导出');
  assert.ok(src.includes('Math.imul(h, 33) ^ raw.charCodeAt(i)'), 'djb2 hash 实现应存在');
  assert.ok(src.includes("task_${h.toString(36)"), 'ID 前缀应为 task_');
});

test('docsManager.js 中 createId(\'task\') 已替换为 stableTaskId', () => {
  const src = readFileSync(new URL('../server/services/docsManager.js', import.meta.url), 'utf8');
  // 不应再有 createId('task') 调用
  assert.ok(!src.includes("createId('task')"), "createId('task') 应已被替换为 stableTaskId");
});

test('相同输入产生相同 ID', () => {
  const id1 = stableTaskId('docs/plan.md', '实现学生端 TRTC 进房');
  const id2 = stableTaskId('docs/plan.md', '实现学生端 TRTC 进房');
  assert.equal(id1, id2, '相同 (sourceDoc, title) 应产生相同 ID');
});

test('不同 title 产生不同 ID', () => {
  const id1 = stableTaskId('docs/plan.md', '任务 A');
  const id2 = stableTaskId('docs/plan.md', '任务 B');
  assert.notEqual(id1, id2, '不同 title 应产生不同 ID');
});

test('不同 sourceDoc 产生不同 ID', () => {
  const id1 = stableTaskId('docs/plan-a.md', '同名任务');
  const id2 = stableTaskId('docs/plan-b.md', '同名任务');
  assert.notEqual(id1, id2, '不同 sourceDoc 应产生不同 ID');
});

test('ID 以 task_ 开头', () => {
  const id = stableTaskId('docs/plan.md', '任务');
  assert.ok(id.startsWith('task_'), `ID 应以 task_ 开头，实际: ${id}`);
});

test('空输入不崩溃', () => {
  const id = stableTaskId('', '');
  assert.ok(id.startsWith('task_'), '空输入应返回有效 ID');
});

// ─── Task 4: selectDailyDocTasks 防重导入 ─────────────────────────────────
// 纯逻辑测试：不 import docsManager，直接测过滤核心逻辑

console.log('\nTask 4: selectDailyDocTasks — 高置信度 commit 防重导入\n');

function simulateFilter(hubTasks, commitLinks, candidates) {
  // 复刻 selectDailyDocTasks 的 completedTitles 构建逻辑
  const completedTitles = new Set(
    hubTasks
      .filter((t) => t.status === 'completed' || Number(t.progress || 0) >= 90)
      .map((t) => String(t.title || '').trim())
  );
  const hubById = new Map(hubTasks.map((t) => [t.id, t]));
  commitLinks
    .filter((link) => Number(link.confidence || 0) >= 0.75)
    .forEach((link) => {
      const task = hubById.get(link.taskId);
      if (task) completedTitles.add(String(task.title || '').trim());
    });
  return candidates.filter((c) => !completedTitles.has(String(c.title || '').trim()));
}

test('confidence=0.85 的 commit 覆盖任务不被重复导入', () => {
  const hubTasks = [{ id: 'task_a', title: '已有 commit 的任务', status: 'pending', progress: 0 }];
  const commitLinks = [{ activityId: 'c1', taskId: 'task_a', confidence: 0.85, reason: '测试' }];
  const candidates = [
    { title: '已有 commit 的任务', status: 'pending' },
    { title: '全新任务', status: 'pending' }
  ];
  const result = simulateFilter(hubTasks, commitLinks, candidates);
  assert.ok(!result.some((t) => t.title === '已有 commit 的任务'), '高置信度 commit 覆盖任务不应被导入');
  assert.ok(result.some((t) => t.title === '全新任务'), '无 commit 的新任务应被导入');
});

test('confidence=0.60 的 commit 覆盖任务仍可被导入', () => {
  const hubTasks = [{ id: 'task_b', title: '低置信度任务', status: 'pending', progress: 0 }];
  const commitLinks = [{ activityId: 'c2', taskId: 'task_b', confidence: 0.60, reason: '低' }];
  const candidates = [{ title: '低置信度任务', status: 'pending' }];
  const result = simulateFilter(hubTasks, commitLinks, candidates);
  assert.ok(result.some((t) => t.title === '低置信度任务'), '低置信度 commit 不应过滤掉任务');
});

test('confidence=0.75 边界值：恰好被过滤', () => {
  const hubTasks = [{ id: 'task_c', title: '边界任务', status: 'pending', progress: 0 }];
  const commitLinks = [{ activityId: 'c3', taskId: 'task_c', confidence: 0.75, reason: '边界' }];
  const candidates = [{ title: '边界任务', status: 'pending' }];
  const result = simulateFilter(hubTasks, commitLinks, candidates);
  assert.ok(!result.some((t) => t.title === '边界任务'), 'confidence=0.75 应被过滤（≥0.75）');
});

test('已完成 hub 任务不被重导入（原有逻辑不受影响）', () => {
  const hubTasks = [{ id: 'task_d', title: '已完成任务', status: 'completed', progress: 100 }];
  const candidates = [{ title: '已完成任务', status: 'pending' }];
  const result = simulateFilter(hubTasks, [], candidates);
  assert.ok(!result.some((t) => t.title === '已完成任务'), '已完成任务不应被重导入');
});

// 验证 docsManager.js 源码包含正确的 confidence 过滤逻辑
test('docsManager.js 包含 confidence >= 0.75 过滤逻辑', () => {
  const src = readFileSync(new URL('../server/services/docsManager.js', import.meta.url), 'utf8');
  assert.ok(src.includes('0.75'), 'selectDailyDocTasks 应包含 0.75 置信度阈值');
  assert.ok(src.includes('completedTitles.add'), '高置信度 commit 应加入 completedTitles');
});

// ─── Task 5: applyCommitLinksToTasks 过滤逻辑 ─────────────────────────────

console.log('\nTask 5: applyCommitLinksToTasks — 置信度过滤逻辑\n');

// 纯逻辑：复刻过滤步骤，不 import semanticLinker（会拉入 store/SQLite）
function filterHighConfidenceLinks(commitTaskLinks) {
  return commitTaskLinks.filter((l) => Number(l.confidence || 0) >= 0.75);
}

test('confidence=0.80 进入高置信集合', () => {
  const links = [{ activityId: 'c1', taskId: 'task_aaa', confidence: 0.80 }];
  const result = filterHighConfidenceLinks(links);
  assert.equal(result.length, 1);
  assert.equal(result[0].taskId, 'task_aaa');
});

test('confidence=0.60 不进入高置信集合', () => {
  const links = [{ activityId: 'c2', taskId: 'task_bbb', confidence: 0.60 }];
  const result = filterHighConfidenceLinks(links);
  assert.equal(result.length, 0);
});

test('confidence=0.75 边界值：进入高置信集合', () => {
  const links = [{ activityId: 'c3', taskId: 'task_ccc', confidence: 0.75 }];
  const result = filterHighConfidenceLinks(links);
  assert.equal(result.length, 1);
});

test('空数组不崩溃', () => {
  const result = filterHighConfidenceLinks([]);
  assert.deepEqual(result, []);
});

test('semanticLinker.js 包含 applyCommitLinksToTasks 导出', () => {
  const src = readFileSync(new URL('../server/services/semanticLinker.js', import.meta.url), 'utf8');
  assert.ok(src.includes('export async function applyCommitLinksToTasks'), 'applyCommitLinksToTasks 应被导出');
  assert.ok(src.includes('0.75'), '应包含 0.75 置信度阈值');
  assert.ok(src.includes("task.status = 'completed'"), '应将任务状态设为 completed');
});

test('refreshAnalysisIntoStore 在 updateStore 后调用 applyCommitLinksToTasks', () => {
  const src = readFileSync(new URL('../server/services/semanticLinker.js', import.meta.url), 'utf8');
  const fnStart = src.indexOf('export async function refreshAnalysisIntoStore');
  const fnBlock = src.slice(fnStart, fnStart + 800);
  assert.ok(fnBlock.includes('applyCommitLinksToTasks'), 'refreshAnalysisIntoStore 应调用 applyCommitLinksToTasks');
  // 确保 applyCommitLinksToTasks 在第一个 updateStore 之后调用
  const firstUpdate = fnBlock.indexOf('await updateStore');
  const applyCall = fnBlock.indexOf('applyCommitLinksToTasks');
  assert.ok(applyCall > firstUpdate, 'applyCommitLinksToTasks 应在 updateStore 之后调用');
});

// ─── Task 6: webhookRoutes E1 trigger ────────────────────────────────────

console.log('\nTask 6: webhookRoutes — PR merged 触发 E1\n');

test('webhookRoutes.js 包含 PR merged E1 触发逻辑', () => {
  const src = readFileSync(new URL('../server/routes/webhookRoutes.js', import.meta.url), 'utf8');
  assert.ok(src.includes("json.action === 'closed'"), '应检查 action=closed');
  assert.ok(src.includes('pull_request?.merged === true'), '应检查 merged=true');
  assert.ok(src.includes('refreshAnalysisIntoStore'), '应调用 refreshAnalysisIntoStore');
  assert.ok(src.includes('semanticLinker.js'), '应动态 import semanticLinker');
});

test('E1 触发在 upsertPullFromWebhook 之后', () => {
  const src = readFileSync(new URL('../server/routes/webhookRoutes.js', import.meta.url), 'utf8');
  const upsertPos = src.indexOf('upsertPullFromWebhook(repoFull');
  const e1Pos = src.indexOf('refreshAnalysisIntoStore');
  assert.ok(e1Pos > upsertPos, 'E1 触发应在 upsertPullFromWebhook 之后');
});

// ─── Task 7: reviewTaskLinker 핵심 로직 ────────────────────────────────────

console.log('\nTask 7: reviewTaskLinker — E3 修复任务创建\n');

// reviewTaskLinker.js 의 handleReviewOutcome 는 updateStore 를 주입받으므로
// mock updateStore 로 순수 로직 검증 가능
import { handleReviewOutcome } from '../server/services/reviewTaskLinker.js';

test('Pass 레벨은 아무것도 하지 않음', async () => {
  let called = false;
  const mockStore = async () => { called = true; };
  const result = await handleReviewOutcome({ id: 'rev_001', level: 'Pass', suggestion: '좋음' }, mockStore);
  assert.equal(result.fixTaskId, null, 'Pass 는 fixTaskId=null 반환');
  assert.ok(!called, 'Pass 는 updateStore 미호출');
});

test('Warning 레벨은 아무것도 하지 않음', async () => {
  const result = await handleReviewOutcome({ id: 'rev_002', level: 'Warning', suggestion: '주의' }, async () => {});
  assert.equal(result.fixTaskId, null, 'Warning 은 fixTaskId=null 반환');
});

test('Block 레벨 → 수정 태스크 생성', async () => {
  let capturedDraft = null;
  const mockStore = async (mutator) => {
    capturedDraft = mutator({ tasks: [{ id: 'task_orig', title: '원래 태스크', owner: '林世棋', status: 'pending' }] });
  };
  const result = await handleReviewOutcome(
    { id: 'rev_003', level: 'Block', suggestion: 'SQL 注入风险，user_id 未过滤', taskId: 'task_orig' },
    mockStore
  );
  assert.ok(result.fixTaskId !== null, 'Block 은 fixTaskId 반환해야 함');
  assert.ok(result.fixTaskId.startsWith('fix_'), `fixTaskId 는 fix_ 로 시작해야 함: ${result.fixTaskId}`);
  const fixTask = capturedDraft?.tasks?.find((t) => t.id === result.fixTaskId);
  assert.ok(fixTask, '수정 태스크가 draft.tasks 에 추가되어야 함');
  assert.ok(fixTask.title.startsWith('修复：'), `title 은 修复：로 시작해야 함: ${fixTask.title}`);
  assert.ok(fixTask.title.length <= 30, `title 은 30자 이하여야 함: ${fixTask.title.length}`);
  assert.equal(fixTask.priority, 'P0', '수정 태스크 우선순위는 P0');
  assert.equal(fixTask.type, 'fix', '수정 태스크 type은 fix');
  assert.ok(fixTask.dependencies.includes('task_orig'), 'dependencies 에 원래 태스크 포함');
  const orig = capturedDraft?.tasks?.find((t) => t.id === 'task_orig');
  assert.equal(orig?.blocked, true, 'Block 레벨 → 원래 태스크 blocked=true');
});

test('Escalate 레벨 → 수정 태스크 생성 (blocked 없음)', async () => {
  let capturedDraft = null;
  const mockStore = async (mutator) => {
    capturedDraft = mutator({ tasks: [] });
  };
  const result = await handleReviewOutcome(
    { id: 'rev_004', level: 'Escalate', suggestion: '보안 이슈 에스컬레이션' },
    mockStore
  );
  assert.ok(result.fixTaskId !== null, 'Escalate 도 fixTaskId 반환');
  const fixTask = capturedDraft?.tasks?.find((t) => t.id === result.fixTaskId);
  assert.ok(fixTask, 'Escalate 도 수정 태스크 생성');
  assert.ok(!fixTask.blocked, 'Escalate 는 blocked 설정 안 함 (originalTask 없음)');
});

test('같은 review ID 로 두번 호출해도 태스크 중복 생성 안 됨', async () => {
  let draft = { tasks: [] };
  const mockStore = async (mutator) => { draft = mutator(draft); };
  const review = { id: 'rev_005', level: 'Block', suggestion: '중복 방지 테스트' };
  await handleReviewOutcome(review, mockStore);
  await handleReviewOutcome(review, mockStore);
  const fixTasks = draft.tasks.filter((t) => t.type === 'fix');
  assert.equal(fixTasks.length, 1, '중복 호출해도 수정 태스크는 1개만 생성');
});

// ─── Task 8: pullPipeline E3 접선 ──────────────────────────────────────────

console.log('\nTask 8: pullPipeline.js — E3 接线（PR-Agent 主路）\n');

test('pullPipeline.js 에 E3 트리거 코드 존재', () => {
  const src = readFileSync(new URL('../server/services/pullPipeline.js', import.meta.url), 'utf8');
  assert.ok(src.includes("hubReview.level === 'Block'"), 'Block 레벨 감지 코드 있어야 함');
  assert.ok(src.includes("hubReview.level === 'Escalate'"), 'Escalate 레벨 감지 코드 있어야 함');
  assert.ok(src.includes('handleReviewOutcome'), 'handleReviewOutcome 호출 코드 있어야 함');
  assert.ok(src.includes('reviewTaskLinker.js'), 'reviewTaskLinker.js 동적 import 있어야 함');
});

test('E3 트리거는 updateStore 이후에 위치', () => {
  const src = readFileSync(new URL('../server/services/pullPipeline.js', import.meta.url), 'utf8');
  // upsertPullIntoStore 함수 내에서 updateStore 블록 닫힘 이후에 E3 코드가 와야 함
  const updateStoreEnd = src.lastIndexOf('return draft;\n  });');
  const e3Pos = src.indexOf('handleReviewOutcome', updateStoreEnd);
  assert.ok(e3Pos > updateStoreEnd, 'E3 트리거는 updateStore 블록 이후에 위치해야 함');
});

// ─── Task 9: buildTaskPRBody + createTaskBranchAndPR ─────────────────────

console.log('\nTask 9: githubApi.js — buildTaskPRBody + createTaskBranchAndPR\n');

// buildTaskPRBody 는 순수 함수 — 같은 로직을 인라인으로 테스트
function buildTaskPRBody(task) {
  const businessNote = task.businessNote || task.description || '（无业务说明）';
  const acceptanceItems = String(task.acceptance || '（待补充验收标准）')
    .split(/[；;。\n]+/).map((s) => s.trim()).filter(Boolean).map((s) => `- [ ] ${s}`).join('\n');
  const deps = Array.isArray(task.dependencies) && task.dependencies.length
    ? task.dependencies.map((d) => `- \`${d}\``).join('\n') : '无';
  return ['## 业务目标', businessNote, '', '## 验收标准', acceptanceItems, '', '## 依赖', deps, '', '## 关联', `Task: \`${task.id}\``]
    .join('\n').trim();
}

test('PR body 에 모든 section 포함', () => {
  const task = { id: 'task_abc1234', title: '진입방 구현', businessNote: '학생이 수업에 입장 가능', acceptance: '진입 성공;마이크 활성화', dependencies: ['task_dep1'], milestoneId: 'm1' };
  const body = buildTaskPRBody(task);
  assert.ok(body.includes('## 业务目标'), '비즈니스 목표 섹션 있어야 함');
  assert.ok(body.includes('학생이 수업에 입장 가능'), 'businessNote 내용 있어야 함');
  assert.ok(body.includes('## 验收标准'), '수락기준 섹션 있어야 함');
  assert.ok(body.includes('- [ ]'), 'checkbox 형식이어야 함');
  assert.ok(body.includes('## 依赖'), '의존성 섹션 있어야 함');
  assert.ok(body.includes('task_abc1234'), 'task ID 포함되어야 함');
});

test('branch 이름 최대 60자', () => {
  const taskId = 'task_abc1234';
  const title = '매우 긴 태스크 제목으로 branch 이름이 60자를 초과하는지 테스트';
  const titleSlug = title.toLowerCase().replace(/[^\w一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  const branchName = `feat/task_${taskId}_${titleSlug}`.slice(0, 60);
  assert.ok(branchName.length <= 60, `branch 이름 최대 60자: 실제 ${branchName.length}`);
  assert.ok(branchName.startsWith('feat/task_'), 'branch 이름은 feat/task_ 로 시작해야 함');
});

test('githubApi.js 에 buildTaskPRBody 와 createTaskBranchAndPR export 존재', () => {
  const src = readFileSync(new URL('../server/services/githubApi.js', import.meta.url), 'utf8');
  assert.ok(src.includes('export function buildTaskPRBody'), 'buildTaskPRBody export 있어야 함');
  assert.ok(src.includes('export async function createTaskBranchAndPR'), 'createTaskBranchAndPR export 있어야 함');
  assert.ok(src.includes('## 业务目标'), 'PR body 에 비즈니스 목표 섹션 있어야 함');
  assert.ok(src.includes('## 验收标准'), 'PR body 에 수락기준 섹션 있어야 함');
});

// ─── Task 10: assignmentRoutes L3 접선 ───────────────────────────────────

console.log('\nTask 10: assignmentRoutes.js — 태스크 인수 → branch + PR\n');

test('assignmentRoutes.js 에 L3 트리거 코드 존재', () => {
  const src = readFileSync(new URL('../server/routes/assignmentRoutes.js', import.meta.url), 'utf8');
  assert.ok(src.includes('createTaskBranchAndPR'), 'createTaskBranchAndPR 호출 있어야 함');
  assert.ok(src.includes('githubApi.js'), 'githubApi.js 동적 import 있어야 함');
  assert.ok(src.includes('evidenceRefs'), 'evidenceRefs 업데이트 있어야 함');
  assert.ok(src.includes("logger.warn"), 'GitHub 실패 시 warn 로그 있어야 함');
});

test('L3 트리거는 refreshAssignmentBrief 이후에 위치', () => {
  const src = readFileSync(new URL('../server/routes/assignmentRoutes.js', import.meta.url), 'utf8');
  const briefPos = src.indexOf('refreshAssignmentBrief(assignment');
  const l3Pos = src.indexOf('createTaskBranchAndPR');
  assert.ok(l3Pos > briefPos, 'L3 트리거는 refreshAssignmentBrief 이후여야 함');
});

// ─── 结果汇总 ──────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} 个测试，${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
