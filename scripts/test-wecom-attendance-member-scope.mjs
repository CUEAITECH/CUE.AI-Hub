import assert from 'node:assert/strict';
import { createWeComRoutes } from '../server/routes/wecomRoutes.js';

function createHarness(initialStore) {
  let responsePayload = null;
  let updateCalls = 0;
  const store = structuredClone(initialStore);
  const route = createWeComRoutes({
    createId: (prefix) => `${prefix}_test`,
    loadStore: async () => store,
    updateStore: async (mutator) => {
      updateCalls++;
      mutator(store);
      return store;
    },
    readBody: async (req) => ({ json: req.json || {} }),
    sendJson: (_res, _status, payload) => {
      responsePayload = payload;
    },
    sendError: (_res, _status, message) => {
      responsePayload = { error: message };
    },
    isWeComAvailable: () => false,
    sendWeComMarkdown: async () => false,
    scanRisks: () => [],
    buildMetrics: () => ({}),
    todayText: () => '2026-07-15',
    normalizeStandup: (item) => item,
    normalizeTask: (item) => item,
    generateAssignmentBrief: async () => ''
  });
  return {
    store,
    get responsePayload() {
      return responsePayload;
    },
    get updateCalls() {
      return updateCalls;
    },
    async postAttendance(json) {
      responsePayload = null;
      await route(
        { method: 'POST', headers: {}, json },
        {},
        new URL('https://hub.cueai.top/api/wecom/attendance')
      );
      return responsePayload;
    },
    async postCommand(json) {
      responsePayload = null;
      await route(
        { method: 'POST', headers: {}, json },
        {},
        new URL('https://hub.cueai.top/api/wecom/command')
      );
      return responsePayload;
    }
  };
}

const baseStore = {
  projects: [{ id: 'cue_ai_classroom', name: 'Cue.AI' }],
  members: [{ name: '林世棋' }, { name: '田家铭' }],
  users: [
    { name: '胡佳涛', username: '胡佳涛', role: 'developer', active: true, projectIds: ['cue_ai_classroom'] },
    { name: '系统管理员', username: 'admin', role: 'admin', active: true, projectIds: ['*'] }
  ],
  attendanceRecords: []
};

const valid = createHarness(baseStore);
const validPayload = await valid.postAttendance({
  text: '林世棋正常出席',
  projectId: 'cue_ai_classroom'
});
assert.equal(validPayload.result, '已记录 林世棋 晚会出席：正常');
assert.equal(valid.updateCalls, 1);
assert.equal(valid.store.attendanceRecords.length, 1);

const unknown = createHarness(baseStore);
const unknownPayload = await unknown.postAttendance({
  text: '路人甲正常出席',
  projectId: 'cue_ai_classroom'
});
assert.match(unknownPayload.result, /未记录/);
assert.match(unknownPayload.result, /不在当前项目考勤范围/);
assert.equal(unknown.updateCalls, 0);
assert.equal(unknown.store.attendanceRecords.length, 0);

const stats = createHarness({
  ...baseStore,
  attendanceRecords: [
    { projectId: 'cue_ai_classroom', date: '2026-07-15', owner: '林世棋', kind: 'meeting', status: 'normal', source: 'wecom' },
    { projectId: 'cue_ai_classroom', date: '2026-07-15', owner: '路人甲', kind: 'meeting', status: 'normal', source: 'wecom' }
  ]
});
const statsPayload = await stats.postCommand({
  text: '今日考勤',
  projectId: 'cue_ai_classroom'
});
assert.equal(statsPayload.records.length, 1);
assert.equal(statsPayload.records[0].owner, '林世棋');
assert.doesNotMatch(statsPayload.result, /路人甲/);

console.log('WeCom attendance member scope OK');
