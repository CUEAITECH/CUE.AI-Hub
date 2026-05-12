import assert from 'node:assert/strict';
import { migrateStore } from '../server/store.js';
import { aggregateDeliverableProgress, buildStageChecklist } from '../server/services/stageChecklist.js';
import { dispatchRoutes } from '../server/routes/index.js';
import { createAssignmentRoutes } from '../server/routes/assignmentRoutes.js';
import { createSystemRoutes } from '../server/routes/systemRoutes.js';
import { createProjectRoutes } from '../server/routes/projectRoutes.js';
import { createWeComRoutes } from '../server/routes/wecomRoutes.js';
import { createTaskRoutes } from '../server/routes/taskRoutes.js';
import { bindActivityToExplicitRefs } from '../server/services/bindingEngine.js';
import { normalizeAssignment, normalizeStandup } from '../server/services/dailyBrief.js';
import { generateAssignmentBrief } from '../server/services/assignmentBrief.js';
import { buildProgressMarkdown, parseDocsForTasks, parseProgressDoc, extractJsonArray, repairLLMJson } from '../server/services/docsManager.js';
import { createSessionToken } from '../server/services/auth.js';

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
  assert.equal(store.tasks[0].progressSource, 'manual');
});

await test('assignment brief falls back to deliverable acceptance when task acceptance is placeholder', async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const store = migrateStore({
    currentStage: legacyStage,
    deliverables: [
      {
        id: 'deliverable_acceptance',
        title: '验收交付项',
        acceptance: '必须跑通端到端联调并提供截图。',
        projectId: 'cue_ai_classroom'
      }
    ],
    tasks: [
      {
        id: 'task_acceptance',
        title: '验收任务',
        acceptance: '待补充验收标准',
        deliverableId: 'deliverable_acceptance',
        projectId: 'cue_ai_classroom'
      }
    ]
  });

  const brief = await generateAssignmentBrief({
    task: store.tasks[0],
    owner: 'tester',
    note: '',
    store
  });
  assert.equal(brief.acceptanceCriteria.includes('必须跑通端到端联调并提供截图。'), true);

  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

await test('task AI progress rewrites automatic progress to latest estimate', async () => {
  let store = migrateStore({
    currentStage: legacyStage,
    tasks: [
      { id: 'task_progress', title: '进度测试任务', owner: 'tester', progress: 70, progressSource: 'auto', status: '进行中' }
    ]
  });
  let responsePayload = null;
  const route = createTaskRoutes({
    loadStore: async () => store,
    updateStore: async (mutator) => {
      store = await mutator(structuredClone(store));
      return store;
    },
    readBody: async () => ({ json: {} }),
    sendJson: (_res, _status, payload) => { responsePayload = payload; },
    sendError: (_res, status, message) => { throw new Error(`${status} ${message}`); },
    normalizeTask: (task) => task,
    estimateTasksProgress: async () => [
      { taskId: 'task_progress', progress: 40, reason: '证据不足', hint: '补充验收截图', suggestComplete: false }
    ],
    generatePlan: async () => []
  });

  const handled = await route({ method: 'POST' }, {}, new URL('http://localhost/api/tasks/ai-progress'));
  assert.equal(handled, true);
  assert.equal(responsePayload.tasks[0].progress, 40);
  assert.equal(responsePayload.tasks[0].progressSource, 'auto');
  assert.equal(responsePayload.tasks[0].aiProgressSuggestion.progress, 40);
  assert.equal(responsePayload.tasks[0].aiProgressSuggestion.appliedProgress, 40);
});

await test('task AI progress preserves manual confirmation while storing AI review estimate', async () => {
  let store = migrateStore({
    currentStage: legacyStage,
    tasks: [
      { id: 'task_manual_progress', title: '人工确认任务', owner: 'tester', progress: 70, progressSource: 'manual', status: '进行中' }
    ]
  });
  let responsePayload = null;
  const route = createTaskRoutes({
    loadStore: async () => store,
    updateStore: async (mutator) => {
      store = await mutator(structuredClone(store));
      return store;
    },
    readBody: async () => ({ json: {} }),
    sendJson: (_res, _status, payload) => { responsePayload = payload; },
    sendError: (_res, status, message) => { throw new Error(`${status} ${message}`); },
    normalizeTask: (task) => task,
    estimateTasksProgress: async () => [
      { taskId: 'task_manual_progress', progress: 40, reason: '证据不足', hint: '补充验收截图', suggestComplete: false }
    ],
    generatePlan: async () => []
  });

  await route({ method: 'POST' }, {}, new URL('http://localhost/api/tasks/ai-progress'));
  assert.equal(responsePayload.tasks[0].progress, 70);
  assert.equal(responsePayload.tasks[0].progressSource, 'manual');
  assert.equal(responsePayload.tasks[0].aiProgressSuggestion.progress, 40);
  assert.equal(responsePayload.tasks[0].aiProgressSuggestion.appliedProgress, 70);
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
  let requestJson = { username: 'tester', password: 'secret', projectId: 'cue_ai_classroom' };
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
  assert.equal(responsePayload.user.username, 'tester');
  assert.equal(responsePayload.user.role, 'admin');
  assert.equal(typeof responsePayload.token, 'string');

  requestJson = { username: 'tester', password: 'wrong', projectId: 'cue_ai_classroom' };
  await route({ method: 'POST', headers: {} }, {}, new URL('http://localhost/api/auth/login'));
  assert.equal(responseStatus, 401);
  assert.equal(responsePayload.ok, false);

  if (originalUser === undefined) delete process.env.HUB_LOGIN_USER;
  else process.env.HUB_LOGIN_USER = originalUser;
  if (originalPassword === undefined) delete process.env.HUB_LOGIN_PASSWORD;
  else process.env.HUB_LOGIN_PASSWORD = originalPassword;
});

await test('phase4 auth route lets project admin register project developer accounts', async () => {
  const originalUser = process.env.HUB_ADMIN_USER;
  const originalPassword = process.env.HUB_ADMIN_PASSWORD;
  process.env.HUB_ADMIN_USER = 'admin_test';
  process.env.HUB_ADMIN_PASSWORD = 'admin_secret';
  let store = migrateStore({});
  let requestJson = {
    projectId: 'cue_ai_classroom',
    adminUsername: 'admin_test',
    adminPassword: 'admin_secret',
    username: 'dev_one',
    password: 'dev_secret',
    name: '开发一号',
    role: 'developer'
  };
  let responsePayload = null;
  let responseStatus = null;
  const route = createSystemRoutes({
    loadStore: async () => store,
    updateStore: async (mutator) => {
      store = await mutator(structuredClone(store));
      return store;
    },
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

  await route({ method: 'POST', headers: {} }, {}, new URL('http://localhost/api/auth/users'));
  assert.equal(responseStatus, 201);
  assert.equal(responsePayload.user.username, 'dev_one');
  assert.equal(responsePayload.user.role, 'developer');
  assert.equal(responsePayload.user.projectRole, 'developer');
  assert.equal(responsePayload.user.passwordHash, undefined);

  const admin = store.users.find((user) => user.username === 'admin_test');
  requestJson = { projectId: 'cue_ai_classroom', role: 'project_admin' };
  await route(
    { method: 'PATCH', headers: { 'x-cue-session-token': createSessionToken(admin, 'cue_ai_classroom') } },
    {},
    new URL(`http://localhost/api/auth/users/${responsePayload.user.id}`)
  );
  assert.equal(responseStatus, 200);
  assert.equal(responsePayload.user.projectRole, 'project_admin');

  requestJson = { username: 'dev_one', password: 'dev_secret', projectId: 'cue_ai_classroom' };
  await route({ method: 'POST', headers: {} }, {}, new URL('http://localhost/api/auth/login'));
  assert.equal(responseStatus, 200);
  assert.equal(responsePayload.user.name, '开发一号');

  if (originalUser === undefined) delete process.env.HUB_ADMIN_USER;
  else process.env.HUB_ADMIN_USER = originalUser;
  if (originalPassword === undefined) delete process.env.HUB_ADMIN_PASSWORD;
  else process.env.HUB_ADMIN_PASSWORD = originalPassword;
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

await test('binding plausibility: blocks cross-domain mistakes via ASCII tokens + LLM phase keywords', () => {
  // 完整复现 projectRoutes 的 isBindingPlausible 逻辑（两层防护）
  const COMMON_ABBREVS = new Set(['api', 'sdk', 'sop', 'sos', 'mvp', 'sku', 'ci', 'cd', 'ui', 'ux']);
  function distinctTokens(text) {
    return (String(text || '').toLowerCase().match(/[a-z][a-z0-9]+/g) || [])
      .filter((t) => t.length >= 4 && !COMMON_ABBREVS.has(t));
  }
  function isTitleConsistent(taskTitle, deliverableTitle) {
    const a = distinctTokens(taskTitle);
    const b = distinctTokens(deliverableTitle);
    if (!a.length || !b.length) return true;
    const al = String(taskTitle).toLowerCase();
    const bl = String(deliverableTitle).toLowerCase();
    if (a.some((t) => bl.includes(t))) return true;
    if (b.some((t) => al.includes(t))) return true;
    return false;
  }
  function extractTokens(text) {
    const tokens = new Set();
    (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).forEach((t) => tokens.add(t));
    const cjk = String(text || '').match(/[一-鿿]+/g) || [];
    for (const run of cjk) {
      for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
      if (run.length === 1) tokens.add(run);
    }
    return tokens;
  }
  function scoreByKw(title, phase) {
    if (!phase || !Array.isArray(phase.productKeywords)) return 0;
    const tl = title.toLowerCase();
    const tt = extractTokens(title);
    let s = 0;
    for (const k of phase.productKeywords) {
      const kl = String(k || '').toLowerCase().trim();
      if (!kl) continue;
      if (tl.includes(kl)) { s += 2; continue; }
      const kt = extractTokens(k);
      for (const t of kt) if (tt.has(t)) { s += 1; break; }
    }
    return s;
  }
  function isBindingPlausible(taskTitle, deliverable, phases) {
    if (!isTitleConsistent(taskTitle, deliverable.title)) return false;
    if (!deliverable.phaseId || !phases?.length) return true;
    let bestScore = 0, bestId = null;
    for (const p of phases) {
      const s = scoreByKw(taskTitle, p);
      if (s > bestScore) { bestScore = s; bestId = p.id; }
    }
    if (!bestId || bestScore < 2) return true;
    if (bestId === deliverable.phaseId) return true;
    const dlvScore = scoreByKw(taskTitle, phases.find((p) => p.id === deliverable.phaseId));
    return bestScore - dlvScore < 2;
  }

  const phases = [
    { id: 'p_backend', title: '第一周后端骨架', productKeywords: ['后端', '服务', 'API', 'Session'] },
    { id: 'p_client', title: '第一周客户端骨架', productKeywords: ['客户端', 'iPad', 'iPhone', 'iOS', '前端', 'App'] }
  ];
  const ipadDlv = { id: 'd_ipad', title: 'iPad 输入端 MVP', phaseId: 'p_client' };
  const backendDlv = { id: 'd_backend', title: '第一周后端交付物', phaseId: 'p_backend' };

  // 用户实测错误 1：ASCII 标识符冲突
  assert.equal(isBindingPlausible('iPhone 端登录与课堂配对', ipadDlv, phases), false,
    'iPhone 任务不该绑到 iPad deliverable（ASCII 冲突）');

  // 用户实测错误 2：纯中文 deliverable 标题 + ASCII 标识符 task → 用 phase keywords 兜底
  assert.equal(isBindingPlausible('iPhone SOS与summary页面', backendDlv, phases), false,
    'iPhone 任务不该绑到纯中文后端 deliverable（phase keywords 兜底）');

  // 同 phase 的 iPad 任务在 iPad deliverable 上正常通过
  assert.equal(isBindingPlausible('iPad 课堂状态同步', ipadDlv, phases), true);
  assert.equal(isBindingPlausible('iPad 教师登录与设备绑定', ipadDlv, phases), true);

  // 后端任务在后端 deliverable 上正常通过（无 ASCII 标识符冲突，phase 也匹配）
  assert.equal(isBindingPlausible('后端 SOP 模板读取', backendDlv, phases), true);

  // 跨项目：Redis 任务 vs Kafka deliverable，ASCII 标识符冲突
  const kafkaDlv = { id: 'd_kafka', title: 'Kafka 消息队列集成' };
  assert.equal(isBindingPlausible('Redis 缓存配置', kafkaDlv, []), false);
});

await test('fuzzy task dedup catches reorder variants via Jaccard + shared prefix', () => {
  function normalize(v) { return String(v || '').replace(/\s+/g, '').replace(/[【】()[\]（）]/g, '').toLowerCase(); }
  function bigrams(text) {
    const tokens = new Set();
    (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).forEach((t) => tokens.add(t));
    const cjk = String(text || '').match(/[一-鿿]+/g) || [];
    for (const run of cjk) {
      for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
      if (run.length === 1) tokens.add(run);
    }
    return tokens;
  }
  function jaccard(a, b) {
    const ta = bigrams(a); const tb = bigrams(b);
    if (!ta.size || !tb.size) return 0;
    let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
    return inter / (ta.size + tb.size - inter || 1);
  }
  function sharedPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0; while (i < n && a[i] === b[i]) i++; return i;
  }
  function isLikelyDuplicate(a, b) {
    if (!a || !b) return false;
    const na = normalize(a); const nb = normalize(b);
    if (na === nb) return true;
    if (Math.abs(na.length - nb.length) <= 8 && (na.includes(nb) || nb.includes(na))) return true;
    if (sharedPrefix(na, nb) >= 4 && jaccard(a, b) >= 0.3) return true;
    return false;
  }

  // 用户实测看到的变体：以前漏过的，现在能识别
  assert.equal(isLikelyDuplicate('iPad音频采集接入', 'iPad 音频输入采集'), true);
  assert.equal(isLikelyDuplicate('iPad 音频输入采集', 'iPad 端音频输入采集'), true);
  assert.equal(isLikelyDuplicate('iPad 课堂状态同步', 'iPad 端课堂状态同步'), true);
  assert.equal(isLikelyDuplicate('iPad 教师登录与设备绑定', 'iPad登录与设备绑定功能'), true);
  // 正常去重也保留
  assert.equal(isLikelyDuplicate('iPad 开始/结束课堂', 'iPad 开始/结束课堂控制'), true);
  // 不同任务不能误判
  assert.equal(isLikelyDuplicate('iPad 音频输入采集', 'iPad 课堂状态同步'), false);
  assert.equal(isLikelyDuplicate('iPhone 登录与课堂配对', 'iPad 开始/结束课堂'), false);
  assert.equal(isLikelyDuplicate('后端 SOP 模板读取', '后端 SOS 请求处理'), false);
});

await test('phase matching is project-agnostic: uses LLM-provided productKeywords, no hardcoded project terms', () => {
  // 复现 projectRoutes.js 中的 findPhaseByLLMKeywords 逻辑（项目无关）
  function extractTokens(text) {
    const tokens = new Set();
    const ascii = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    ascii.forEach((t) => tokens.add(t));
    const cjkRuns = String(text || '').match(/[一-鿿]+/g) || [];
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
      if (run.length === 1) tokens.add(run);
    }
    return tokens;
  }
  function findByKw(title, phases) {
    if (!title || !phases.length) return { phaseId: null, score: 0 };
    const tl = title.toLowerCase();
    const tt = extractTokens(title);
    let best = null; let bestScore = 0;
    for (const phase of phases) {
      const keywords = phase.productKeywords || [];
      let score = 0;
      for (const kw of keywords) {
        const kl = String(kw || '').toLowerCase().trim();
        if (!kl) continue;
        if (tl.includes(kl)) { score += 2; continue; }
        const kt = extractTokens(kw);
        for (const t of kt) if (tt.has(t)) { score += 1; break; }
      }
      if (score > bestScore) { bestScore = score; best = phase.id; }
    }
    return { phaseId: best, score: bestScore };
  }

  // 场景 1：cue_ai_classroom（双设备课堂）
  const classroomPhases = [
    { id: 'p_backend', title: '第一周后端骨架', productKeywords: ['后端', '服务', 'API', 'Session'] },
    { id: 'p_client', title: '第一周客户端骨架', productKeywords: ['客户端', 'iPad', 'iPhone', 'iOS', '前端', 'App'] },
    { id: 'p_integration', title: '第一周三端联调', productKeywords: ['联调', '三端', '全链路', 'CI', '环境'] },
    { id: 'p_trtc_backend', title: 'TRTC后端改造', productKeywords: ['TRTC', 'UserSig', 'ASR', '后端'] },
    { id: 'p_trtc_client', title: 'TRTC客户端接入', productKeywords: ['TRTC', '客户端', '学生', 'Web'] }
  ];
  assert.equal(findByKw('iPad 输入端 MVP', classroomPhases).phaseId, 'p_client', 'iPad → 客户端');
  assert.equal(findByKw('iPhone 输出端 MVP', classroomPhases).phaseId, 'p_client', 'iPhone → 客户端');
  assert.equal(findByKw('后端服务 MVP', classroomPhases).phaseId, 'p_backend');
  assert.equal(findByKw('CI/CD 流水线配置', classroomPhases).phaseId, 'p_integration');

  // 场景 2：电商项目（完全不同的产品端，验证项目无关性）
  const ecommercePhases = [
    { id: 'p_sku', title: '商品管理', productKeywords: ['SKU', '商品', '库存', '类目'] },
    { id: 'p_order', title: '订单系统', productKeywords: ['订单', '支付', '退款', '物流'] },
    { id: 'p_admin', title: '运营后台', productKeywords: ['后台', '管理', '运营', 'Dashboard'] }
  ];
  // 在电商场景下也能正确匹配——完全不依赖 iPad/TRTC 等术语
  assert.equal(findByKw('SKU 批量导入功能', ecommercePhases).phaseId, 'p_sku');
  assert.equal(findByKw('订单超时退款', ecommercePhases).phaseId, 'p_order');
  assert.equal(findByKw('运营后台数据看板', ecommercePhases).phaseId, 'p_admin');

  // 场景 3：游戏项目
  const gamePhases = [
    { id: 'p_combat', title: '战斗系统', productKeywords: ['战斗', '伤害', '技能', '怪物'] },
    { id: 'p_economy', title: '经济系统', productKeywords: ['货币', '商城', '充值', '掉落'] }
  ];
  assert.equal(findByKw('技能伤害公式调优', gamePhases).phaseId, 'p_combat');
  assert.equal(findByKw('商城充值入口', gamePhases).phaseId, 'p_economy');
});

await test('extractJsonArray: balanced bracket matching survives nested arrays', () => {
  // 之前的 bug：非贪婪正则 \[[\s\S]*?\] 会在第一个 ] 截断
  const input = '```json\n[\n  {"title": "T1", "tags": ["a", "b"]},\n  {"title": "T2"}\n]\n```';
  const parsed = extractJsonArray(input);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].tags.length, 2);
  assert.equal(parsed[1].title, 'T2');
});

await test('repairLLMJson: fixes unescaped double quotes inside string values', () => {
  // 用户实测看到的 LLM 错误：description 字段里有未转义的英文引号
  const broken = '[{"title": "T1", "description": "清理 UI 中"输入端/输出端"旧叙事", "status": "pending"}]';
  // 直接 JSON.parse 会失败
  assert.throws(() => JSON.parse(broken));
  // repairLLMJson 修复后能解析
  const repaired = repairLLMJson(broken);
  const parsed = JSON.parse(repaired);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'T1');
  assert.match(parsed[0].description, /输入端\/输出端/);
  assert.equal(parsed[0].status, 'pending');

  // 多层嵌套
  const broken2 = '[{"x": "前后"中"间"末"}]';
  const r2 = JSON.parse(repairLLMJson(broken2));
  assert.equal(r2[0].x, '前后"中"间"末');

  // 正常 JSON 不应被破坏
  const normal = '[{"a": "b", "c": "d\\"e"}]';
  const r3 = JSON.parse(repairLLMJson(normal));
  assert.equal(r3[0].a, 'b');
  assert.equal(r3[0].c, 'd"e');
});

await test('reset-roadmap purges stale doc-imported tasks but preserves completed/evidenced/claimed/manual', async () => {
  const { createPlanningRoutes } = await import('../server/routes/planningRoutes.js');
  let store = migrateStore({
    deliverables: [{ id: 'd1', projectId: 'cue_ai_classroom', title: 'D1', phaseId: null, taskIds: [] }],
    phases: [{ id: 'ph1', projectId: 'cue_ai_classroom', title: 'P1' }],
    currentStage: { id: 'stage', name: 'S', shortName: 'S', checklist: [], phases: [] },
    tasks: [
      // 应当删除：未完成、来自旧文档、无证据
      { id: 't_stale', title: '旧文档任务', projectId: 'cue_ai_classroom', sourceDoc: 'docs/old.md', status: 'pending', deliverableId: 'd1' },
      // 应当保留：已完成
      { id: 't_done', title: '已完成任务', projectId: 'cue_ai_classroom', sourceDoc: 'docs/old.md', status: '已完成', deliverableId: 'd1' },
      // 应当保留：有 commit 证据
      { id: 't_evidenced', title: '有 commit 任务', projectId: 'cue_ai_classroom', sourceDoc: 'docs/old.md', status: 'pending', deliverableId: 'd1' },
      // 应当保留：已被认领
      { id: 't_claimed', title: '已认领任务', projectId: 'cue_ai_classroom', sourceDoc: 'docs/old.md', status: 'pending', deliverableId: 'd1' },
      // 应当保留：人工创建（无 sourceDoc）
      { id: 't_manual', title: '手工任务', projectId: 'cue_ai_classroom', sourceDoc: '', status: 'pending', deliverableId: 'd1' }
    ],
    activities: [
      { id: 'a1', type: 'commit', projectId: 'cue_ai_classroom', taskId: 't_evidenced', deliverableId: 'd1' }
    ],
    assignments: [
      { id: 'as1', projectId: 'cue_ai_classroom', taskId: 't_claimed', owner: 'tester' }
    ]
  });

  let responsePayload = null;
  const route = createPlanningRoutes({
    loadStore: async () => store,
    saveStore: async (next) => { store = next; return next; },
    updateStore: async (mutator) => { store = await mutator(structuredClone(store)); return store; },
    readBody: async () => ({ json: { projectId: 'cue_ai_classroom', purgeStaleTasks: true } }),
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
  assert.equal(responsePayload.purgedStaleTasks, 1, '应删除 1 个过时任务（t_stale）');
  const remainingIds = store.tasks.map((t) => t.id).sort();
  assert.deepEqual(remainingIds, ['t_claimed', 't_done', 't_evidenced', 't_manual'], '保留：已完成 / 有 commit / 已认领 / 手工');
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

await test('cleanup endpoint resets unclaimed task owner to 待认领 and stashes LLM suggestion', async () => {
  const { createPlanningRoutes } = await import('../server/routes/planningRoutes.js');
  let store = migrateStore({
    deliverables: [],
    phases: [],
    currentStage: { id: 'stage', name: 'S', shortName: 'S', checklist: [], phases: [] },
    tasks: [
      // 未被认领：LLM 预填了 owner，应被重置
      { id: 't_unclaimed', title: '未认领任务', projectId: 'cue_ai_classroom', owner: '田家铭', status: 'pending' },
      // 已认领：owner 应保留
      { id: 't_claimed', title: '已认领任务', projectId: 'cue_ai_classroom', owner: '罗子宽', status: 'pending' },
      // 已完成：owner 应保留
      { id: 't_done', title: '完成任务', projectId: 'cue_ai_classroom', owner: '林世棋', status: '已完成' },
      // 已是待认领：不动
      { id: 't_already', title: '已是待认领', projectId: 'cue_ai_classroom', owner: '待认领', status: 'pending' }
    ],
    assignments: [
      { id: 'a1', taskId: 't_claimed', owner: '罗子宽', projectId: 'cue_ai_classroom' }
    ]
  });

  let responsePayload = null;
  const route = createPlanningRoutes({
    loadStore: async () => store,
    saveStore: async (next) => { store = next; return next; },
    updateStore: async (mutator) => { store = await mutator(structuredClone(store)); return store; },
    readBody: async () => ({ json: {} }),
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

  await route({ method: 'POST' }, {}, new URL('http://localhost/api/tasks/cleanup'));

  assert.equal(responsePayload.resetOwners, 1, '只重置 1 个未认领任务的 owner');
  const unclaimed = store.tasks.find((t) => t.id === 't_unclaimed');
  assert.equal(unclaimed.owner, '待认领');
  assert.equal(unclaimed.suggestedOwner, '田家铭', 'LLM 建议保留到 suggestedOwner');
  assert.equal(store.tasks.find((t) => t.id === 't_claimed').owner, '罗子宽', '已认领 owner 不变');
  assert.equal(store.tasks.find((t) => t.id === 't_done').owner, '林世棋', '已完成 owner 不变');
});
