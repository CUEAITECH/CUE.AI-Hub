import assert from 'node:assert/strict';
import { migrateStore } from '../server/store.js';
import { aggregateDeliverableProgress, buildStageChecklist } from '../server/services/stageChecklist.js';
import { dispatchRoutes } from '../server/routes/index.js';
import { createAssignmentRoutes } from '../server/routes/assignmentRoutes.js';
import { createSystemRoutes } from '../server/routes/systemRoutes.js';
import { createProjectRoutes } from '../server/routes/projectRoutes.js';
import { createWeComRoutes } from '../server/routes/wecomRoutes.js';
import { bindActivityToExplicitRefs } from '../server/services/bindingEngine.js';
import { normalizeAssignment, normalizeStandup } from '../server/services/dailyBrief.js';
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

await test('phase3.2 assignment completion confirms linked task completion', async () => {
  let store = migrateStore({
    currentStage: legacyStage,
    tasks: [
      { id: 'task_confirm', title: '确认完成任务', owner: 'tester', progress: 40, status: '进行中' }
    ],
    assignments: [
      { id: 'assign_confirm', taskId: 'task_confirm', taskTitle: '确认完成任务', owner: 'tester', date: '2026-05-11', status: '进行中' }
    ]
  });
  let responsePayload = null;
  const route = createAssignmentRoutes({
    loadStore: async () => store,
    updateStore: async (mutator) => {
      store = await mutator(structuredClone(store));
      return store;
    },
    normalizeAssignment,
    generateAssignmentBrief: async () => ({}),
    todayText: () => '2026-05-11',
    readBody: async () => ({ json: { status: '已完成' } }),
    sendJson: (_res, _status, payload) => { responsePayload = payload; },
    sendError: (_res, status, message) => { throw new Error(`${status} ${message}`); }
  });

  const handled = await route({ method: 'PATCH' }, {}, new URL('http://localhost/api/assignments/assign_confirm'));
  assert.equal(handled, true);
  assert.equal(responsePayload.assignment.status, '已完成');
  assert.equal(responsePayload.task.status, '已完成');
  assert.equal(responsePayload.task.progress, 100);
  assert.equal(store.tasks[0].completionSource, 'assignment');
});

await test('phase4 state route filters project scoped records while keeping project switch list', async () => {
  const store = migrateStore({
    projects: [
      { id: 'project_one', name: 'Project One' },
      { id: 'project_two', name: 'Project Two' }
    ],
    currentStage: legacyStage,
    phases: [
      { id: 'phase_one', title: 'One', projectId: 'project_one' },
      { id: 'phase_two', title: 'Two', projectId: 'project_two' }
    ],
    deliverables: [
      { id: 'deliverable_one', title: 'One deliverable', phaseId: 'phase_one', projectId: 'project_one' },
      { id: 'deliverable_two', title: 'Two deliverable', phaseId: 'phase_two', projectId: 'project_two' }
    ],
    tasks: [
      { id: 'task_one', title: 'One task', projectId: 'project_one', deliverableId: 'deliverable_one' },
      { id: 'task_two', title: 'Two task', projectId: 'project_two', deliverableId: 'deliverable_two' }
    ],
    activities: [
      { id: 'commit_one', type: 'commit', title: 'one', projectId: 'project_one' },
      { id: 'commit_two', type: 'commit', title: 'two', projectId: 'project_two' }
    ],
    assignments: [
      { id: 'assign_one', taskId: 'task_one', taskTitle: 'One task', projectId: 'project_one' },
      { id: 'assign_two', taskId: 'task_two', taskTitle: 'Two task', projectId: 'project_two' }
    ],
    reviews: [
      { id: 'review_one', title: 'one', projectId: 'project_one' },
      { id: 'review_two', title: 'two', projectId: 'project_two' }
    ]
  });
  let responsePayload = null;
  const route = createSystemRoutes({
    loadStore: async () => store,
    scanRisks: () => [],
    normalizeStageName: (stage) => stage,
    buildMetrics: (scopedStore) => ({ taskCount: scopedStore.tasks.length }),
    buildStageChecklist,
    aggregateDeliverableProgress,
    buildOpenApiSpec: () => ({}),
    sendJson: (_res, _status, payload) => { responsePayload = payload; },
    port: 0,
    cueApiKey: '',
    isWeComAvailable: () => false,
    meetingHour: 18,
    hubUrl: ''
  });

  const handled = await route({ method: 'GET', headers: {} }, {}, new URL('http://localhost/api/state?projectId=project_two'));
  assert.equal(handled, true);
  assert.equal(responsePayload.currentProjectId, 'project_two');
  const projectIds = responsePayload.projects.map((project) => project.id);
  assert.equal(projectIds.includes('project_one'), true);
  assert.equal(projectIds.includes('project_two'), true);
  assert.deepEqual(responsePayload.tasks.map((task) => task.id), ['task_two']);
  assert.deepEqual(responsePayload.activities.map((activity) => activity.id), ['commit_two']);
  assert.deepEqual(responsePayload.assignments.map((assignment) => assignment.id), ['assign_two']);
  assert.deepEqual(responsePayload.reviews.map((review) => review.id), ['review_two']);
  assert.equal(responsePayload.metrics.taskCount, 1);
});

await test('phase4 auth route validates hub login credentials', async () => {
  const originalUser = process.env.HUB_LOGIN_USER;
  const originalPassword = process.env.HUB_LOGIN_PASSWORD;
  process.env.HUB_LOGIN_USER = 'tester';
  process.env.HUB_LOGIN_PASSWORD = 'secret';
  let requestJson = { username: 'tester', password: 'secret' };
  let responsePayload = null;
  let responseStatus = null;
  const route = createSystemRoutes({
    loadStore: async () => migrateStore({}),
    readBody: async () => ({ json: requestJson }),
    scanRisks: () => [],
    normalizeStageName: (stage) => stage,
    buildMetrics: () => ({}),
    buildStageChecklist,
    aggregateDeliverableProgress,
    buildOpenApiSpec: () => ({}),
    sendJson: (_res, status, payload) => { responseStatus = status; responsePayload = payload; },
    port: 0,
    cueApiKey: '',
    isWeComAvailable: () => false,
    meetingHour: 18,
    hubUrl: ''
  });

  await route({ method: 'POST', headers: {} }, {}, new URL('http://localhost/api/auth/login'));
  assert.equal(responseStatus, 200);
  assert.equal(responsePayload.ok, true);

  requestJson = { username: 'tester', password: 'wrong' };
  await route({ method: 'POST', headers: {} }, {}, new URL('http://localhost/api/auth/login'));
  assert.equal(responseStatus, 401);
  assert.equal(responsePayload.ok, false);

  if (originalUser === undefined) delete process.env.HUB_LOGIN_USER;
  else process.env.HUB_LOGIN_USER = originalUser;
  if (originalPassword === undefined) delete process.env.HUB_LOGIN_PASSWORD;
  else process.env.HUB_LOGIN_PASSWORD = originalPassword;
});

await test('phase4 project routes create, update, and guard deletion of linked projects', async () => {
  let requestJson = {};
  let store = migrateStore({
    projects: [{ id: 'project_existing', name: 'Existing' }],
    tasks: [{ id: 'task_existing', title: 'Existing task', projectId: 'project_existing' }]
  });
  let responsePayload = null;
  let errorPayload = null;
  const route = createProjectRoutes({
    createId: (prefix) => `${prefix}_fixed`,
    loadStore: async () => store,
    updateStore: async (mutator) => {
      store = await mutator(structuredClone(store));
      return store;
    },
    readBody: async () => ({ json: requestJson }),
    sendJson: (_res, status, payload) => { responsePayload = { status, ...payload }; },
    sendError: (_res, status, message, details) => { errorPayload = { status, message, details }; },
    hasGitHubConfig: () => false,
    scanGitHubProject: async () => ({}),
    scanLocalGitProject: async () => ({}),
    syncGitHubProjectIntoStore: async () => ({}),
    githubSyncErrorHint: () => '',
    reviewChange: async () => ({}),
    scanRisks: () => [],
    buildMetrics: () => ({}),
    fetchProjectDocs: async () => [],
    parseDocsForTasks: async () => [],
    parseProgressDoc: () => [],
    parsePhasesFromDocs: async () => null,
    selectDailyDocTasks: () => [],
    buildProgressMarkdown: () => '',
    writeProgressToGitHub: async () => ({}),
    defaultStageChecklist: [],
    reassignChecklistPhaseIds: (nodes) => nodes,
    todayText: () => '2026-05-11'
  });

  requestJson = {
    name: 'Project Two',
    githubFullRepo: 'CUEAITECH/Project-Two',
    summary: 'second project'
  };
  await route({ method: 'POST' }, {}, new URL('http://localhost/api/projects'));
  assert.equal(responsePayload.status, 201);
  assert.equal(responsePayload.project.id, 'project_cueaitech_project_two');
  assert.equal(responsePayload.project.githubOwner, 'CUEAITECH');
  assert.equal(responsePayload.project.repository, 'Project-Two');

  requestJson = { githubFullRepo: 'CUEAITECH/Project-Two-Renamed', resetSync: true };
  await route({ method: 'PATCH' }, {}, new URL('http://localhost/api/projects/project_cueaitech_project_two'));
  assert.equal(responsePayload.project.repository, 'Project-Two-Renamed');
  assert.equal(responsePayload.project.status, '待同步');

  await route({ method: 'DELETE' }, {}, new URL('http://localhost/api/projects/project_existing'));
  assert.equal(errorPayload.status, 409);
  assert.equal(errorPayload.details.links.tasks, 1);

  await route({ method: 'DELETE' }, {}, new URL('http://localhost/api/projects/project_cueaitech_project_two'));
  assert.equal(responsePayload.deleted, true);
  assert.equal(store.projects.some((project) => project.id === 'project_cueaitech_project_two'), false);
});

await test('phase4 wecom routes respect project context for tasks and claims', async () => {
  let requestJson = {};
  let store = migrateStore({
    projects: [
      { id: 'project_one', name: 'Project One' },
      { id: 'project_two', name: 'Project Two' }
    ],
    tasks: [
      { id: 'task_one', title: 'One task', owner: 'A', status: '进行中', projectId: 'project_one' },
      { id: 'task_two', title: 'Two task', owner: 'B', status: '进行中', projectId: 'project_two' }
    ],
    assignments: []
  });
  let responsePayload = null;
  const route = createWeComRoutes({
    createId: (prefix) => `${prefix}_fixed`,
    loadStore: async () => store,
    updateStore: async (mutator) => {
      store = await mutator(structuredClone(store));
      return store;
    },
    readBody: async () => ({ json: requestJson }),
    sendJson: (_res, _status, payload) => { responsePayload = payload; },
    sendError: (_res, status, message) => { throw new Error(`${status} ${message}`); },
    isWeComAvailable: () => true,
    sendWeComMarkdown: async () => true,
    scanRisks: () => [],
    buildMetrics: (scopedStore) => ({ taskCount: scopedStore.tasks.length }),
    todayText: () => '2026-05-11',
    normalizeStandup,
    normalizeTask: (task) => task,
    generateAssignmentBrief: async () => ({ generatedBy: 'test' })
  });

  await route({ method: 'GET' }, {}, new URL('http://localhost/api/wecom/tasks?projectId=project_two'));
  assert.equal(responsePayload.projectId, 'project_two');
  assert.deepEqual(responsePayload.tasks.map((task) => task.id), ['task_two']);

  requestJson = { owner: 'Tester', taskKeyword: 'Two', projectId: 'project_two' };
  await route({ method: 'POST' }, {}, new URL('http://localhost/api/wecom/claim'));
  assert.match(responsePayload.result, /已认领/);
  assert.equal(store.assignments[0].projectId, 'project_two');
  assert.equal(store.assignments[0].taskId, 'task_two');
});

// ===== Phase 5：reset 后行为 + 防幽灵 deliverable + 模糊去重 =====

await test('reset semantics: migrateStore preserves empty deliverables when explicitly cleared', () => {
  // 用户点了重置路径图后的 store 状态
  const resetStore = {
    deliverables: [],   // 关键：字段存在但显式为空
    phases: [],
    currentStage: {
      id: 'stage_test',
      name: '测试阶段',
      shortName: '测试',
      checklist: [],
      phases: []
    },
    tasks: [
      { id: 'task_1', title: '已存在任务', projectId: 'cue_ai_classroom', deliverableId: null }
    ]
  };
  const migrated = migrateStore(resetStore);
  // 必须保持空，不能从 defaultStageChecklist 自动复活幽灵 deliverable
  assert.equal(migrated.deliverables.length, 0, 'reset 后 deliverables 必须保持为空');
  assert.equal(migrated.phases.length, 0, 'reset 后 phases 必须保持为空');
});

await test('legacy migration still backfills deliverables when key is absent', () => {
  // 老版本数据：没有 deliverables 字段（首次迁移）
  const legacyStoreNoDeliverables = {
    currentStage: legacyStage,
    tasks: []
  };
  const migrated = migrateStore(legacyStoreNoDeliverables);
  assert.ok(migrated.deliverables.length > 0, 'legacy 首次迁移仍应从 checklist 生成 deliverable');
  assert.ok(migrated.phases.length > 0, 'legacy 首次迁移仍应从 phases 生成');
});

await test('aggregateDeliverableProgress returns empty when no deliverables (no ghost fallback)', () => {
  const store = {
    deliverables: [],
    phases: [],
    tasks: [
      { id: 'task_1', title: 'iPad 任务', projectId: 'cue_ai_classroom', deliverableId: null, progress: 50 }
    ],
    activities: [],
    reviews: [],
    assignments: [],
    currentStage: { checklist: [], phases: [] }
  };
  const result = aggregateDeliverableProgress(store);
  assert.equal(result.deliverables.length, 0, '空 deliverable 时不能回退到默认 5 个幽灵节点');
  assert.equal(result.metrics.total, 0);
  assert.equal(result.metrics.progress, 0);
});

await test('cross-deliverable contamination guard: task with deliverableId pointing elsewhere is excluded from keyword fallback', () => {
  const store = {
    deliverables: [
      {
        id: 'dlv_backend',
        projectId: 'cue_ai_classroom',
        phaseId: 'phase_p1',
        title: '后端实时课堂链路',
        keywords: ['后端', 'sos', 'session'],
        acceptance: '后端验收',
        taskIds: []
      },
      {
        id: 'dlv_iphone',
        projectId: 'cue_ai_classroom',
        phaseId: 'phase_p2',
        title: 'iPhone 输出端 MVP',
        keywords: ['iphone', 'sos'],
        acceptance: 'iPhone 验收',
        taskIds: []
      }
    ],
    phases: [
      { id: 'phase_p1', title: 'P1', projectId: 'cue_ai_classroom' },
      { id: 'phase_p2', title: 'P2', projectId: 'cue_ai_classroom' }
    ],
    tasks: [
      // 这个任务显式绑定到 iPhone deliverable，标题含 'sos' 关键词
      // 不能被 dlv_backend 通过 'sos' 关键词兜底拉过去
      {
        id: 'task_iphone_sos',
        title: 'iPhone SOS 触发与结果展示',
        projectId: 'cue_ai_classroom',
        deliverableId: 'dlv_iphone',
        progress: 30,
        status: 'pending'
      }
    ],
    activities: [],
    reviews: [],
    assignments: [],
    currentStage: { checklist: [], phases: [] }
  };
  const result = aggregateDeliverableProgress(store);
  const backend = result.deliverables.find((d) => d.id === 'dlv_backend');
  const iphone = result.deliverables.find((d) => d.id === 'dlv_iphone');
  assert.equal(backend.linkedTasks.length, 0, 'dlv_backend 不能通过关键词兜底拉过已绑到其他 deliverable 的任务');
  assert.equal(iphone.linkedTasks.length, 1, 'dlv_iphone 应当通过显式 FK 拥有该任务');
  assert.equal(iphone.linkedTasks[0].id, 'task_iphone_sos');
});

await test('reset-roadmap route strips task/activity/assignment deliverableId for project', async () => {
  const { createPlanningRoutes } = await import('../server/routes/planningRoutes.js');
  let store = migrateStore({
    deliverables: [
      { id: 'dlv_old', projectId: 'cue_ai_classroom', title: '老 Deliverable', phaseId: null, taskIds: ['task_a'] }
    ],
    phases: [{ id: 'phase_old', projectId: 'cue_ai_classroom', title: '老 Phase' }],
    currentStage: { id: 'stage', name: 'S', shortName: 'S', checklist: [], phases: [] },
    tasks: [
      { id: 'task_a', title: 'A', projectId: 'cue_ai_classroom', deliverableId: 'dlv_old' },
      { id: 'task_b', title: 'B', projectId: 'cue_ai_classroom', deliverableId: 'dlv_old' }
    ],
    activities: [
      { id: 'act_1', type: 'commit', projectId: 'cue_ai_classroom', deliverableId: 'dlv_old', taskId: 'task_a' }
    ],
    assignments: [
      { id: 'asg_1', projectId: 'cue_ai_classroom', deliverableId: 'dlv_old', taskId: 'task_a', owner: 'tester' }
    ],
    docTasks: { cue_ai_classroom: [{ title: '文档任务', deliverableTitle: '老 Deliverable' }] }
  });

  let responsePayload = null;
  const route = createPlanningRoutes({
    loadStore: async () => store,
    saveStore: async (next) => { store = next; return next; },
    updateStore: async (mutator) => { store = await mutator(structuredClone(store)); return store; },
    readBody: async () => ({ json: { projectId: 'cue_ai_classroom' } }),
    sendJson: (_res, _status, payload) => { responsePayload = payload; },
    sendError: (_res, status, message) => { throw new Error(`${status} ${message}`); },
    buildStageChecklist,
    aggregateDeliverableProgress,
    buildHybridAnalysis: async () => ({}),
    scanRisks: () => [],
    buildMetrics: () => ({}),
    generatePlanAlternatives: async () => [],
    normalizePlanStageUpdate: (u) => u,
    applyPlanAdjustmentToStage: (d) => d
  });

  await route({ method: 'POST' }, {}, new URL('http://localhost/api/stage/reset-roadmap'));

  assert.equal(responsePayload.ok, true);
  assert.equal(responsePayload.strippedBindings, 2, '应当剥离 2 个 task 的 deliverableId');
  assert.equal(store.deliverables.length, 0, 'deliverables 应当被清空');
  assert.equal(store.phases.length, 0, 'phases 应当被清空');
  assert.equal(store.tasks[0].deliverableId, null, 'task A 的 deliverableId 应当为 null');
  assert.equal(store.tasks[1].deliverableId, null, 'task B 的 deliverableId 应当为 null');
  assert.equal(store.activities[0].deliverableId, null, 'activity 的 deliverableId 应当为 null');
  assert.equal(store.assignments[0].deliverableId, null, 'assignment 的 deliverableId 应当为 null');
  assert.equal(store.docTasks?.cue_ai_classroom, undefined, 'docTasks 应当被清空');
});
