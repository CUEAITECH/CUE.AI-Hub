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
