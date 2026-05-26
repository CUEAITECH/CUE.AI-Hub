/**
 * test-frontend-stores-extended.mjs
 *
 * 验收条件：
 *   1. sessionStore: applyLogin / clearSession / token 生命周期
 *   2. projectStore: selectProject / resolveInitialProjectId 边界
 *   3. taskStore: mergeTask / upsertTasks 幂等性 + 字段保留
 *   4. pullStore: mergePull / applyPrReviewEvent 事件驱动状态
 *   5. eventStore: normalizeGroupedEvents 数据结构规范化
 *   6. observabilityStore: updateLlmStats / updateEvents / updateSyncHealth
 *   7. selectors: findById / rowsForOwner 查询
 */

import assert from 'node:assert/strict';

import { applyLogin, clearSession }             from '../src/state/sessionStore.js';
import { selectProject, resolveInitialProjectId } from '../src/state/projectStore.js';
import { mergeTask, upsertTasks }               from '../src/state/taskStore.js';
import { mergePull, applyPrReviewEvent }        from '../src/state/pullStore.js';
import { normalizeGroupedEvents }               from '../src/state/eventStore.js';
import { updateLlmStats, updateEvents, updateSyncHealth } from '../src/state/observabilityStore.js';
import { findById, rowsForOwner }               from '../src/state/selectors.js';

// ══════════════════════════════════════════════════════════════════════════════
// 1. sessionStore
// ══════════════════════════════════════════════════════════════════════════════
{
  // applyLogin sets isAuthenticated + token + user
  const s1 = applyLogin({}, { token: 'tok_1', user: { name: 'Alice', projectRole: 'project_admin' } });
  assert.equal(s1.isAuthenticated, true,       'applyLogin: isAuthenticated');
  assert.equal(s1.token, 'tok_1',              'applyLogin: token');
  assert.equal(s1.user.name, 'Alice',          'applyLogin: user.name');
  assert.equal(s1.user.projectRole, 'project_admin', 'applyLogin: user.projectRole');

  // Subsequent applyLogin replaces token
  const s2 = applyLogin(s1, { token: 'tok_2', user: { name: 'Bob', projectRole: 'developer' } });
  assert.equal(s2.token, 'tok_2',              'applyLogin: token replaced');
  assert.equal(s2.user.name, 'Bob',            'applyLogin: user replaced');

  // clearSession resets everything
  const s3 = clearSession(s2);
  assert.equal(s3.isAuthenticated, false,      'clearSession: isAuthenticated false');
  assert.equal(s3.token, '',                   'clearSession: token cleared');

  // clearSession on empty state must not throw
  assert.doesNotThrow(() => clearSession({}),  'clearSession on empty state safe');

  console.log('✓ sessionStore: applyLogin + clearSession lifecycle OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. projectStore
// ══════════════════════════════════════════════════════════════════════════════
{
  // selectProject: sets currentProjectId
  const state = { projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }] };
  const s1 = selectProject(state, 'p2');
  assert.equal(s1.currentProjectId, 'p2', 'selectProject sets currentProjectId');

  // selectProject does not mutate original
  assert.equal(state.currentProjectId, undefined, 'selectProject: pure function');

  // selectProject with empty string → resolves to first project
  const s2 = selectProject(state, '');
  assert.equal(s2.currentProjectId, 'p1', 'selectProject: empty id falls back to first project');

  // resolveInitialProjectId: returns first project when no stored id
  assert.equal(resolveInitialProjectId('', [{ id: 'p1' }, { id: 'p2' }]), 'p1',
    'resolveInitialProjectId: first project when no stored id');

  // resolveInitialProjectId: returns stored id when valid
  assert.equal(resolveInitialProjectId('p2', [{ id: 'p1' }, { id: 'p2' }]), 'p2',
    'resolveInitialProjectId: returns stored id when exists');

  // resolveInitialProjectId: falls back to first when stored id not in list
  assert.equal(resolveInitialProjectId('p99', [{ id: 'p1' }, { id: 'p2' }]), 'p1',
    'resolveInitialProjectId: falls back to first when stored id gone');

  // resolveInitialProjectId: empty project list
  assert.equal(resolveInitialProjectId('', []), '',
    'resolveInitialProjectId: returns empty string for empty list');

  console.log('✓ projectStore: selectProject + resolveInitialProjectId OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. taskStore
// ══════════════════════════════════════════════════════════════════════════════
{
  // mergeTask: updates existing task, preserves untouched fields
  const tasks0 = [
    { id: 't1', title: '任务A', state: 'pending', risk: '高', owner: 'Alice' },
    { id: 't2', title: '任务B', state: 'pending', risk: '中', owner: 'Bob' },
  ];
  const tasks1 = mergeTask(tasks0, { id: 't1', state: 'in_progress' });
  assert.equal(tasks1[0].state, 'in_progress', 'mergeTask: updates state');
  assert.equal(tasks1[0].title, '任务A',        'mergeTask: preserves title');
  assert.equal(tasks1[0].owner, 'Alice',         'mergeTask: preserves owner');
  assert.equal(tasks1.length, 2,                'mergeTask: length unchanged');

  // mergeTask: pure function — original unchanged
  assert.equal(tasks0[0].state, 'pending',      'mergeTask: does not mutate input');

  // mergeTask: adds new task when id not found
  const tasks2 = mergeTask(tasks0, { id: 't3', title: '任务C', state: 'pending', risk: '低' });
  assert.equal(tasks2.length, 3,                'mergeTask: adds new task');

  // upsertTasks: batch update
  const tasks3 = upsertTasks(tasks0, [
    { id: 't1', risk: '低' },
    { id: 't3', title: '任务C', state: 'done', risk: '低' },
  ]);
  assert.equal(tasks3.find((t) => t.id === 't1').risk, '低',   'upsertTasks: updates existing');
  assert.ok(tasks3.find((t) => t.id === 't3'),                  'upsertTasks: adds new');

  // upsertTasks: empty patch list returns same content
  const tasks4 = upsertTasks(tasks0, []);
  assert.equal(tasks4.length, tasks0.length, 'upsertTasks: empty patch is safe');

  // upsertTasks: empty initial list
  const tasks5 = upsertTasks([], [{ id: 't1', title: 'X' }]);
  assert.equal(tasks5.length, 1, 'upsertTasks: works on empty initial list');

  console.log('✓ taskStore: mergeTask + upsertTasks OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. pullStore
// ══════════════════════════════════════════════════════════════════════════════
{
  // mergePull: adds new PR
  const p1 = mergePull([], { id: 'pr_1', title: 'feat: login', state: 'open', number: 42 });
  assert.equal(p1.length, 1,            'mergePull: adds new PR');
  assert.equal(p1[0].title, 'feat: login', 'mergePull: title preserved');

  // mergePull: updates existing PR
  const p2 = mergePull(p1, { id: 'pr_1', title: 'feat: login v2' });
  assert.equal(p2.length, 1,            'mergePull: no duplicate');
  assert.equal(p2[0].title, 'feat: login v2', 'mergePull: updates title');

  // mergePull: pure function
  assert.equal(p1[0].title, 'feat: login', 'mergePull: does not mutate input');

  // applyPrReviewEvent: delta merge into realtimeCompliance
  const p3 = applyPrReviewEvent(p2, { prId: 'pr_1', complianceDelta: { done: ['AC1', 'AC2'] } });
  assert.deepEqual(p3[0].realtimeCompliance.done, ['AC1', 'AC2'],
    'applyPrReviewEvent: done list merged');

  // applyPrReviewEvent: PR not in list — no crash
  const p4 = applyPrReviewEvent(p2, { prId: 'pr_99', complianceDelta: { done: [] } });
  assert.equal(p4.length, p2.length, 'applyPrReviewEvent: unknown prId safe');

  // applyPrReviewEvent: multiple fields in delta
  const p5 = applyPrReviewEvent(p3, { prId: 'pr_1', complianceDelta: { score: 88, reviewerName: 'Claude' } });
  const pr = p5.find((p) => p.id === 'pr_1');
  assert.equal(pr.realtimeCompliance.score, 88, 'applyPrReviewEvent: numeric field OK');

  console.log('✓ pullStore: mergePull + applyPrReviewEvent OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. eventStore
// ══════════════════════════════════════════════════════════════════════════════
{
  // normalizeGroupedEvents: basic structure
  const g1 = normalizeGroupedEvents({
    totalEvents: 5,
    grouped: {
      Alice: [{ id: 'e1', type: 'task.claimed' }, { id: 'e2', type: 'pr.merged' }],
      Bob:   [{ id: 'e3', type: 'pr.review.posted' }],
    },
  });
  assert.equal(g1.totalEvents, 5,   'normalizeGroupedEvents: totalEvents');
  assert.equal(g1.actors.length, 2, 'normalizeGroupedEvents: 2 actors');
  const alice = g1.actors.find((a) => a.actor === 'Alice');
  assert.ok(alice, 'normalizeGroupedEvents: Alice present');
  assert.equal(alice.events.length, 2, 'normalizeGroupedEvents: Alice 2 events');

  // normalizeGroupedEvents: empty payload
  const g2 = normalizeGroupedEvents({});
  assert.equal(g2.totalEvents, 0,   'normalizeGroupedEvents: empty → totalEvents 0');
  assert.equal(g2.actors.length, 0, 'normalizeGroupedEvents: empty → actors []');

  // normalizeGroupedEvents: null/undefined payload safe
  assert.doesNotThrow(() => normalizeGroupedEvents(null),     'normalizeGroupedEvents: null safe');
  assert.doesNotThrow(() => normalizeGroupedEvents(undefined), 'normalizeGroupedEvents: undefined safe');

  // normalizeGroupedEvents: non-array events treated as empty
  const g3 = normalizeGroupedEvents({ totalEvents: 1, grouped: { Alice: null } });
  assert.equal(g3.actors[0].events.length, 0, 'normalizeGroupedEvents: null events → []');

  console.log('✓ eventStore: normalizeGroupedEvents OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. observabilityStore
// ══════════════════════════════════════════════════════════════════════════════
{
  // updateLlmStats
  const s1 = updateLlmStats({}, { total: 10, cacheHitRate: 0.8 });
  assert.equal(s1.llm.total, 10,           'updateLlmStats: total');
  assert.equal(s1.llm.cacheHitRate, 0.8,  'updateLlmStats: cacheHitRate');

  // updateLlmStats is pure
  const base = { other: 'preserved' };
  const s2 = updateLlmStats(base, { total: 5 });
  assert.equal(s2.other, 'preserved',     'updateLlmStats: preserves existing fields');

  // updateEvents: array normalization
  const s3 = updateEvents({}, [{ id: 'e1' }, { id: 'e2' }]);
  assert.equal(s3.events.length, 2,       'updateEvents: events stored');

  const s4 = updateEvents({}, null);
  assert.equal(s4.events.length, 0,       'updateEvents: null → empty array');

  // updateSyncHealth
  const s5 = updateSyncHealth({}, { ok: true, repos: ['r1'] });
  assert.equal(s5.syncHealth.ok, true,    'updateSyncHealth: ok');
  assert.equal(s5.syncHealth.repos[0], 'r1', 'updateSyncHealth: repos');

  console.log('✓ observabilityStore: updateLlmStats + updateEvents + updateSyncHealth OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. selectors
// ══════════════════════════════════════════════════════════════════════════════
{
  const items = [
    { id: 'a', owner: 'Alice', risk: '高' },
    { id: 'b', owner: 'Bob',   risk: '中' },
    { id: 'c', owner: 'Alice', risk: '低' },
  ];

  // findById: returns item or null (not undefined)
  assert.equal(findById(items, 'a').id, 'a',  'findById: finds by id');
  assert.equal(findById(items, 'z'),    null,  'findById: returns null for missing');
  assert.equal(findById([], 'a'),       null,  'findById: empty array returns null');

  // rowsForOwner
  const aliceRows = rowsForOwner(items, 'Alice');
  assert.equal(aliceRows.length, 2, 'rowsForOwner: 2 Alice rows');
  assert.ok(aliceRows.every((r) => r.owner === 'Alice'), 'rowsForOwner: all belong to Alice');

  const noneRows = rowsForOwner(items, 'Charlie');
  assert.equal(noneRows.length, 0, 'rowsForOwner: empty for unknown owner');

  console.log('✓ selectors: findById + rowsForOwner OK');
}

console.log('\nAll extended store tests passed ✓');
