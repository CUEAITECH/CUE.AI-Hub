import assert from 'node:assert/strict';
import { migrateStore } from '../server/store.js';
import { aggregateDeliverableProgress, buildStageChecklist } from '../server/services/stageChecklist.js';
import { dispatchRoutes } from '../server/routes/index.js';
import { bindActivityToExplicitRefs } from '../server/services/bindingEngine.js';
import { normalizeAssignment } from '../server/services/dailyBrief.js';
import { buildProgressMarkdown, parseDocsForTasks, parseProgressDoc } from '../server/services/docsManager.js';

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`not ok ${name}`);
    throw error;
  }
}

const legacyStage = {
  id: 'stage_custom',
  name: 'Cue.AI 测试阶段',
  shortName: '测试阶段',
  phases: [
    { id: 'phase_alpha', title: 'Alpha', status: '进行中' },
    { id: 'phase_beta', title: 'Beta', status: '待开始' }
  ],
  checklist: [
    {
      id: 'deliverable_alpha',
      phaseId: 'phase_alpha',
      title: 'Alpha 交付项',
      owner: '后端',
      keywords: ['alpha', 'api'],
      acceptance: 'Alpha 验收'
    },
    {
      id: 'deliverable_beta',
      phaseId: 'phase_beta',
      title: 'Beta 交付项',
      owner: '前端',
      keywords: ['beta', 'ui'],
      acceptance: 'Beta 验收'
    }
  ]
};

await test('phase1 migration creates top-level phases and deliverables without breaking old checklist', () => {
  const migrated = migrateStore({
    currentStage: legacyStage,
    checklistOverrides: {
      deliverable_alpha: { status: '已完成', by: 'tester', at: '2026-05-09T00:00:00.000Z' }
    },
    tasks: [
      { id: 'undefined_1', title: 'Alpha API', linkedRefs: ['cue-project-hub#1'] }
    ],
    activities: [
      { id: 'activity_1', type: 'commit', diff: 'secret diff', title: 'alpha api commit' }
    ],
    assignments: [
      { id: 'assign_1', taskId: 'task_1', owner: 'tester' }
    ]
  });

  assert.equal(migrated.currentStage.checklist.length, 2);
  assert.equal(migrated.deliverables.length, 2);
  assert.equal(migrated.phases.length, 2);
  assert.equal(migrated.deliverables[0].id, 'deliverable_alpha');
  assert.equal(migrated.deliverables[0].manualOverride.status, '已完成');
  assert.equal(migrated.phases[0].projectId, 'cue_ai_classroom');
  assert.equal(migrated.tasks[0].id, 'task_1');
  assert.equal(migrated.tasks[0].projectId, 'cue_ai_classroom');
  assert.equal(migrated.tasks[0].deliverableId, 'deliverable_alpha');
  assert.deepEqual(migrated.tasks[0].linkedRefs, ['CUEAITECH/Cue.AI#1']);
  assert.equal(migrated.activities[0].deliverableId, 'deliverable_alpha');
  assert.equal(migrated.activities[0].taskId, 'task_1');
  assert.equal(Object.hasOwn(migrated.activities[0], 'diff'), false);
  assert.equal(migrated.assignments[0].deliverableId, 'deliverable_alpha');
});

await test('phase0 compatibility keeps buildStageChecklist reading currentStage checklist', () => {
  const store = migrateStore({
    currentStage: legacyStage,
    deliverables: [
      {
        id: 'deliverable_alpha',
        phaseId: 'phase_alpha',
        title: '不应覆盖旧路径图标题',
        progress: 100,
        status: '已完成'
      }
    ]
  });

  const checklist = buildStageChecklist(store);
  assert.equal(checklist.checklist[0].title, 'Alpha 交付项');
  assert.equal(checklist.checklist.length, 2);
});

await test('deliverable aggregation uses deliverables and derives phase metrics', () => {
  const store = migrateStore({
    currentStage: legacyStage,
    deliverables: [
      {
        id: 'deliverable_alpha',
        phaseId: 'phase_alpha',
        title: 'Alpha 交付项',
        owner: '后端',
        keywords: ['alpha'],
        progress: 80,
        status: '推进中'
      },
      {
        id: 'deliverable_beta',
        phaseId: 'phase_beta',
        title: 'Beta 交付项',
        owner: '前端',
        keywords: ['beta'],
        progress: 20,
        status: '待补证据'
      }
    ],
    phases: legacyStage.phases
  });

  const progress = aggregateDeliverableProgress(store);
  assert.equal(progress.deliverables.length, 2);
  assert.equal(progress.metrics.total, 2);
  assert.equal(progress.metrics.progress, 50);
  assert.equal(progress.phases.find((phase) => phase.id === 'phase_alpha').progress, 80);
  assert.equal(progress.phases.find((phase) => phase.id === 'phase_beta').deliverableCount, 1);
});

await test('route dispatcher preserves phase0 ordered route handling', async () => {
  const calls = [];
  const handled = await dispatchRoutes([
    async () => {
      calls.push('first');
      return false;
    },
    async () => {
      calls.push('second');
      return true;
    },
    async () => {
      calls.push('third');
      return true;
    }
  ], {}, {}, new URL('http://localhost/api/test'));

  assert.equal(handled, true);
  assert.deepEqual(calls, ['first', 'second']);
});

await test('phase2 checklist scoring prefers deliverable FK over keyword fallback', () => {
  const store = migrateStore({
    currentStage: legacyStage,
    deliverables: legacyStage.checklist,
    tasks: [
      {
        id: 'task_bound',
        title: '完全不包含关键词的后端工作',
        progress: 80,
        status: '进行中',
        deliverableId: 'deliverable_alpha'
      },
      {
        id: 'task_keyword_noise',
        title: 'alpha api 但属于其他交付项',
        progress: 10,
        status: '进行中',
        deliverableId: 'deliverable_beta'
      }
    ],
    activities: [
      {
        id: 'activity_bound',
        type: 'commit',
        title: 'unrelated commit title',
        taskId: 'task_bound',
        deliverableId: 'deliverable_alpha'
      }
    ],
    assignments: [
      {
        id: 'assign_bound',
        taskId: 'task_bound',
        taskTitle: '完全不包含关键词的后端工作',
        deliverableId: 'deliverable_alpha'
      }
    ]
  });

  const checklist = buildStageChecklist(store).checklist;
  const alpha = checklist.find((item) => item.id === 'deliverable_alpha');
  assert.equal(alpha.progress, 80);
  assert.deepEqual(alpha.linkedTasks.map((task) => task.id), ['task_bound']);
  assert.equal(alpha.evidence.commits[0].id, 'activity_bound');
  assert.equal(alpha.evidence.assignments[0].id, 'assign_bound');
  assert.equal(alpha.linkMode, 'fk');
  assert.equal(alpha.binding.label, '显式 FK');
  assert.equal(alpha.binding.strength, 'strong');
  assert.equal(alpha.binding.counts.fkTasks, 1);
  assert.match(alpha.binding.explanation, /deliverableId/);
});

await test('phase2 activity and assignment writes persist explicit task and deliverable bindings', () => {
  const store = migrateStore({
    currentStage: legacyStage,
    deliverables: legacyStage.checklist.map((item) => ({
      ...item,
      taskIds: item.id === 'deliverable_alpha' ? ['task_alpha'] : []
    })),
    tasks: [
      {
        id: 'task_alpha',
        title: 'Alpha API',
        projectId: 'cue_ai_classroom',
        deliverableId: 'deliverable_alpha'
      }
    ]
  });

  const activity = bindActivityToExplicitRefs({
    id: 'commit_1',
    type: 'commit',
    title: 'finish task_alpha usersig api',
    files: ['server/api.js']
  }, store);
  assert.equal(activity.taskId, 'task_alpha');
  assert.equal(activity.deliverableId, 'deliverable_alpha');
  assert.equal(activity.projectId, 'cue_ai_classroom');

  const assignment = normalizeAssignment({
    id: 'assign_alpha',
    owner: 'tester',
    taskId: 'task_alpha'
  }, store);
  assert.equal(assignment.taskId, 'task_alpha');
  assert.equal(assignment.taskTitle, 'Alpha API');
  assert.equal(assignment.deliverableId, 'deliverable_alpha');
  assert.equal(assignment.projectId, 'cue_ai_classroom');
});

await test('phase2 migration backfills historical task, activity, and assignment bindings', () => {
  const migrated = migrateStore({
    currentStage: legacyStage,
    deliverables: legacyStage.checklist,
    tasks: [
      {
        id: 'task_historical',
        title: 'Beta UI polish',
        progress: 30,
        projectId: 'cue_ai_classroom'
      }
    ],
    activities: [
      {
        id: 'commit_historical',
        type: 'commit',
        title: 'finish task_historical',
        files: ['src/ui.js']
      }
    ],
    assignments: [
      {
        id: 'assign_historical',
        taskId: 'task_historical',
        owner: 'tester',
        taskTitle: 'Beta UI polish'
      }
    ]
  });

  assert.equal(migrated.tasks[0].deliverableId, 'deliverable_beta');
  assert.equal(migrated.activities[0].taskId, 'task_historical');
  assert.equal(migrated.activities[0].deliverableId, 'deliverable_beta');
  assert.equal(migrated.assignments[0].deliverableId, 'deliverable_beta');
});

await test('phase2 checklist exposes weak keyword fallback diagnostics', () => {
  const store = {
    currentStage: legacyStage,
    deliverables: legacyStage.checklist,
    tasks: [
      {
        id: 'task_keyword_only',
        title: 'Alpha API',
        progress: 15,
        status: '进行中',
        deliverableId: null
      }
    ]
  };

  const alpha = buildStageChecklist(store).checklist.find((item) => item.id === 'deliverable_alpha');
  assert.equal(alpha.linkMode, 'rules');
  assert.equal(alpha.binding.label, '关键词兜底');
  assert.equal(alpha.binding.strength, 'weak');
});

await test('phase3 progress doc parser reads completion suggestions', () => {
  const items = parseProgressDoc([
    '- ✅ **后端模块化重构**（成员A）',
    '- 🔶 `P0` **TRTC全链路联调**',
    '- ⬜ **iPhone 输出端**'
  ].join('\n'));

  assert.deepEqual(items, [
    { title: '后端模块化重构', docStatus: '已完成' },
    { title: 'TRTC全链路联调', docStatus: '进行中' },
    { title: 'iPhone 输出端', docStatus: '未开始' }
  ]);
});

await test('phase3 progress markdown is deliverable first', () => {
  const markdown = buildProgressMarkdown(
    { id: 'cue_ai_classroom', name: 'Cue.AI' },
    [],
    [{ title: '旧任务', status: 'completed' }],
    [],
    '2026-05-09',
    [
      { id: 'd1', phaseId: 'phase_backend', title: '后端模块化重构', owner: '成员A', status: '已完成', acceptance: '后端验收' },
      { id: 'd2', phaseId: 'phase_trtc', title: 'TRTC全链路联调', owner: '全员', status: '推进中', docSuggestComplete: true }
    ]
  );

  assert.match(markdown, /## phase_backend/);
  assert.match(markdown, /- ✅ \*\*后端模块化重构\*\*/);
  assert.match(markdown, /- 🔶 \*\*TRTC全链路联调\*\*/);
  assert.match(markdown, /文档侧已标记完成，等待 Hub 人工确认。/);
  assert.match(markdown, /2 交付项/);
});

await test('phase3 task parser ignores progress tracking doc', async () => {
  const tasks = await parseDocsForTasks([
    { path: 'docs/阶段进度追踪.md', name: '阶段进度追踪.md', content: '- ✅ **后端模块化重构**' }
  ]);
  assert.deepEqual(tasks, []);
});
