import assert from 'node:assert/strict';
import { applyLogin, clearSession } from '../src/state/sessionStore.js';
import { selectProject, resolveInitialProjectId } from '../src/state/projectStore.js';
import { mergeTask, upsertTasks } from '../src/state/taskStore.js';
import { mergePull, applyPrReviewEvent } from '../src/state/pullStore.js';
import { normalizeGroupedEvents } from '../src/state/eventStore.js';
import { updateLlmStats, updateSyncHealth } from '../src/state/observabilityStore.js';
import { findById, rowsForOwner } from '../src/state/selectors.js';

const session = applyLogin({}, { token: 'tok', user: { name: 'Alice' } });
assert.equal(session.isAuthenticated, true);
assert.equal(session.token, 'tok');
assert.equal(session.user.name, 'Alice');
assert.equal(clearSession(session).isAuthenticated, false);

const projectState = selectProject({ projects: [{ id: 'p1' }, { id: 'p2' }] }, 'p2');
assert.equal(projectState.currentProjectId, 'p2');
assert.equal(resolveInitialProjectId('', [{ id: 'p1' }]), 'p1');

const tasks = upsertTasks([{ id: 't1', title: 'A' }], [{ id: 't2', title: 'B' }]);
assert.equal(tasks.length, 2);
assert.equal(mergeTask(tasks, { id: 't1', title: 'A2' })[0].title, 'A2');

const pulls = mergePull([{ id: 'pr1', title: 'Old' }], { id: 'pr1', title: 'New' });
assert.equal(pulls[0].title, 'New');
const reviewed = applyPrReviewEvent(pulls, { prId: 'pr1', complianceDelta: { done: ['AC1'] } });
assert.deepEqual(reviewed[0].realtimeCompliance.done, ['AC1']);

const grouped = normalizeGroupedEvents({ grouped: { Alice: [{ id: 1, type: 'task.claimed' }] }, totalEvents: 1 });
assert.equal(grouped.totalEvents, 1);
assert.equal(grouped.actors[0].actor, 'Alice');

assert.equal(updateLlmStats({}, { total: 2 }).llm.total, 2);
assert.equal(updateSyncHealth({}, { ok: true }).syncHealth.ok, true);
assert.equal(findById([{ id: 'x' }], 'x').id, 'x');
assert.equal(rowsForOwner([{ owner: 'Alice' }, { owner: 'Bob' }], 'Alice').length, 1);

console.log('frontend store tests OK');

// PR Pipeline: additional pull store edge-case tests
{
  const { mergePull: mP, applyPrReviewEvent: aPRE } = await import('../src/state/pullStore.js');
  const p0 = [];
  const p1 = mP(p0, { id: 'pr_1', title: 'feat: add login', state: 'open', number: 42 });
  assert.equal(p1.length, 1);
  assert.equal(p1[0].title, 'feat: add login');

  const p2 = mP(p1, { id: 'pr_1', title: 'feat: add login v2' });
  assert.equal(p2.length, 1);
  assert.equal(p2[0].title, 'feat: add login v2');

  const p3 = aPRE(p2, { pullId: 'pr_1', complianceDelta: { 'CI 通过': true } });
  assert.deepEqual(p3[0].realtimeCompliance['CI 通过'], true);

  console.log('PR Pipeline store edge-case tests OK');
}
