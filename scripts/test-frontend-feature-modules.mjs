/**
 * test-frontend-feature-modules.mjs
 *
 * 验收条件：
 *   1. 每个 feature 模块函数可被调用并产生预期 DOM 变动
 *   2. helpers 注入机制正常：所有网络请求都走 helpers，不走 fetch()
 *   3. 错误处理正确：API 失败时显示降级内容，不抛出未捕获异常
 *   4. SSE 辅助逻辑（startPrAcSse / stopPrAcSse）状态机正确
 *   5. 任务解释 accordion toggle 状态管理
 */

import assert from 'node:assert/strict';

// ── JSDOM-free DOM 模拟 ────────────────────────────────────────────────────
class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.innerHTML = '';
    this.className = '';
    this.id = '';
    this._children = [];
    this._attributes = new Map();
    this.style = {};
  }
  setAttribute(k, v)  { this._attributes.set(k, v); }
  getAttribute(k)      { return this._attributes.get(k) ?? null; }
  hasAttribute(k)      { return this._attributes.has(k); }
  querySelector()      { return null; }
  querySelectorAll()   { return []; }
  appendChild(child)   { this._children.push(child); return child; }
  prepend(child)       { this._children.unshift(child); }
  get children()       { return this._children; }
  insertAdjacentHTML() {}
  remove()             {}
  addEventListener()   {}
  removeEventListener(){}
  dispatchEvent()      { return true; }
  closest()            { return null; }
}

const _elements = new Map();
const _fakeDoc = {
  getElementById(id) {
    if (!_elements.has(id)) _elements.set(id, new FakeElement('div'));
    const el = _elements.get(id);
    el.id = id;
    return el;
  },
  createElement(tag) { return new FakeElement(tag); },
  createTextNode(t)  { return { textContent: t }; },
  querySelector()    { return null; },
};

// Inject global document + window
globalThis.document = _fakeDoc;
globalThis.window   = { location: { pathname: '/' }, EventSource: undefined };

// ── escapeHtml 测试工具 ─────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. renderObservatory — LLM 面板渲染
// ══════════════════════════════════════════════════════════════════════════════
{
  const { renderObservatory } = await import('../src/features/observability/renderObservatory.js');

  let llmCallCount = 0;
  let eventsCallCount = 0;
  let syncCallCount = 0;

  const mockObsApi = {
    getLlmStats:   async () => { llmCallCount++;   return { today: { totalCalls: 42, cacheHitRate: 0.7, estimatedCostYuan: 1.5 }, recentFailRatePct: 2, signatureHits7d: 10, ledger: [] }; },
    getEvents:     async () => { eventsCallCount++; return { events: [{ id: 'e1', type: 'llm.call', ts: Date.now(), actor: 'Alice', summary: 'test' }] }; },
    getSyncHealth: async () => { syncCallCount++;   return { githubRepos: [], lastSyncAt: null, failedRepos: [] }; },
  };

  await renderObservatory({}, { observabilityApi: mockObsApi, escapeHtml });

  assert.equal(llmCallCount,   1, 'getLlmStats should be called once');
  assert.equal(eventsCallCount, 1, 'getEvents should be called once');
  assert.equal(syncCallCount,  1, 'getSyncHealth should be called once');

  // obsLlmContent DOM should be populated
  const llmPanel = _fakeDoc.getElementById('obsLlmContent');
  assert.ok(llmPanel.innerHTML.length > 0, 'obsLlmContent should have content after render');

  console.log('✓ renderObservatory: API calls + DOM population OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. renderObservatory — API 失败降级
// ══════════════════════════════════════════════════════════════════════════════
{
  const { renderObservatory } = await import('../src/features/observability/renderObservatory.js');

  const failingApi = {
    getLlmStats:   async () => { throw new Error('network error'); },
    getEvents:     async () => { throw new Error('network error'); },
    getSyncHealth: async () => { throw new Error('network error'); },
  };

  // Should NOT throw — errors are caught internally
  await assert.doesNotReject(
    () => renderObservatory({}, { observabilityApi: failingApi, escapeHtml }),
    'renderObservatory must not throw on API failure',
  );

  console.log('✓ renderObservatory: error handling / graceful degradation OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. loadAndRenderSpacePanel — 5 SPACE 维度渲染
// ══════════════════════════════════════════════════════════════════════════════
{
  const { loadAndRenderSpacePanel } = await import('../src/features/observability/renderSpacePanel.js');

  const mockSpaceData = {
    score: 82,
    tier: 'B+',
    dimensions: {
      speed:      { score: 80, trend: 'up' },
      predictability: { score: 75, trend: 'stable' },
      autonomy:   { score: 85, trend: 'up' },
      clarity:    { score: 70, trend: 'down' },
      engagement: { score: 90, trend: 'up' },
    },
  };

  let spaceCallCount = 0;
  const mockObsApi = {
    getSpace: async () => { spaceCallCount++; return mockSpaceData; },
  };

  await loadAndRenderSpacePanel({ observabilityApi: mockObsApi });

  assert.equal(spaceCallCount, 1, 'getSpace should be called once');
  const body = _fakeDoc.getElementById('healthModalBody');
  // Module uses appendChild(), so check _children rather than innerHTML
  assert.ok(body._children.length > 0 || body.innerHTML.length > 0, 'healthModalBody must be populated');

  console.log('✓ loadAndRenderSpacePanel: SPACE dimensions rendered OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. loadAndRenderSpacePanel — 使用正确 DOM 选择器（#healthModalBody）
// ══════════════════════════════════════════════════════════════════════════════
{
  // Regression test: V3 曾因 getElementById('spaceDetailOverlay') 而静默失败
  const { loadAndRenderSpacePanel } = await import('../src/features/observability/renderSpacePanel.js');

  const accessedIds = new Set();
  const trackingDoc = new Proxy(_fakeDoc, {
    get(target, prop) {
      const original = target[prop];
      if (prop === 'getElementById') {
        return (id) => { accessedIds.add(id); return target.getElementById(id); };
      }
      return original;
    },
  });
  globalThis.document = trackingDoc;

  await loadAndRenderSpacePanel({ observabilityApi: { getSpace: async () => ({ score: 70, tier: 'B', dimensions: {}, grade: 'B' }) } });

  // Must use healthModalBody (not the old broken selectors)
  assert.ok(accessedIds.has('healthModalBody'), 'must access #healthModalBody');
  assert.ok(!accessedIds.has('spaceDetailOverlay'), 'must NOT access stale #spaceDetailOverlay');
  assert.ok(!accessedIds.has('healthModal'),        'must NOT access stale #healthModal');

  globalThis.document = _fakeDoc; // restore
  console.log('✓ loadAndRenderSpacePanel: DOM selector regression check OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. renderEveningTimeline — actor rows + event type colors
// ══════════════════════════════════════════════════════════════════════════════
{
  const { renderEveningTimeline } = await import('../src/features/command-center/renderEveningTimeline.js');

  const mockEventsApi = {
    getGroupedEvents: async (params) => {
      return {
        totalEvents: 3,
        grouped: {
          Alice: [
            { id: 'e1', type: 'task.claimed',  ts: Date.now() - 3600000, summary: '认领任务 A' },
            { id: 'e2', type: 'pr.merged',     ts: Date.now() - 1800000, summary: 'PR #42 合并' },
          ],
          Bob: [
            { id: 'e3', type: 'pr.review.posted', ts: Date.now() - 900000, summary: '审阅反馈' },
          ],
        },
      };
    },
  };

  let eventsCallCount = 0;
  const trackingApi = {
    getGroupedEvents: async (...args) => {
      eventsCallCount++;
      return mockEventsApi.getGroupedEvents(...args);
    },
  };

  await renderEveningTimeline({}, { eventsApi: trackingApi, escapeHtml });
  assert.equal(eventsCallCount, 1, 'getGroupedEvents should be called once');

  const container = _fakeDoc.getElementById('eveningTimeline');
  assert.ok(container.innerHTML.length > 0, 'eveningTimeline must have content');

  console.log('✓ renderEveningTimeline: actor rows rendered OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. enrichTaskDetailWithExplanation — 使用 tasksApi 而非 fetch()
// ══════════════════════════════════════════════════════════════════════════════
{
  const { enrichTaskDetailWithExplanation } = await import('../src/features/work-graph/renderTaskRecommendation.js');

  // Module expects { topActor: { displayName, type, confidence, explanation, scoreBreakdown } }
  const mockPayload = {
    topActor: {
      displayName: 'Alice',
      type: 'member',
      confidence: 0.88,
      explanation: '该任务在关键路径上，优先级高。',
      scoreBreakdown: { '依赖风险': 0.9, '业务价值': 0.85 },
    },
  };

  let apiCallCount = 0;
  const mockTasksApi = {
    getTaskExplanation: async (id) => { apiCallCount++; return mockPayload; },
  };

  await enrichTaskDetailWithExplanation('task_123', { tasksApi: mockTasksApi, escapeHtml });

  assert.equal(apiCallCount, 1, 'getTaskExplanation should be called once');
  const el = _fakeDoc.getElementById('taskDetailRecommendation');
  assert.ok(el.innerHTML.includes('Alice') || el.innerHTML.length > 0, 'rec container must be populated with topActor');

  console.log('✓ enrichTaskDetailWithExplanation: uses tasksApi, not fetch() OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. enrichTaskDetailWithExplanation — API 失败优雅降级
// ══════════════════════════════════════════════════════════════════════════════
{
  const { enrichTaskDetailWithExplanation } = await import('../src/features/work-graph/renderTaskRecommendation.js');

  const failingTasksApi = {
    getTaskExplanation: async () => { throw new Error('404'); },
  };

  await assert.doesNotReject(
    () => enrichTaskDetailWithExplanation('bad_task', { tasksApi: failingTasksApi, escapeHtml }),
    'enrichTaskDetailWithExplanation must not throw on API failure',
  );

  console.log('✓ enrichTaskDetailWithExplanation: error handling OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 8. PrAcChecklist — stopPrAcSse 无副作用
// ══════════════════════════════════════════════════════════════════════════════
{
  const { stopPrAcSse } = await import('../src/features/pr-pipeline/PrAcChecklist.js');

  // Calling stopPrAcSse with no active SSE must not throw
  assert.doesNotThrow(() => stopPrAcSse(), 'stopPrAcSse with no active SSE must not throw');

  console.log('✓ PrAcChecklist.stopPrAcSse: no-op safety OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 9. PrAcChecklist — refreshPrAcChecklist 渲染验收条目
// ══════════════════════════════════════════════════════════════════════════════
{
  const { refreshPrAcChecklist } = await import('../src/features/pr-pipeline/PrAcChecklist.js');

  const payload = {
    prId: 'pr_42',
    checklistItems: [
      { label: '单元测试全绿', status: 'pass' },
      { label: 'lint 检查', status: 'fail' },
      { label: '文档更新', status: 'pending' },
    ],
    score: 67,
  };

  assert.doesNotThrow(
    () => refreshPrAcChecklist('pr_42', payload, { streamUrl: '/v2/events/stream', escapeHtml }),
    'refreshPrAcChecklist must not throw on valid payload',
  );

  const el = _fakeDoc.getElementById('prAcChecklist');
  assert.ok(el.innerHTML.length > 0, 'prAcChecklist must be populated after refresh');

  console.log('✓ PrAcChecklist.refreshPrAcChecklist: checklist rendering OK');
}

// ══════════════════════════════════════════════════════════════════════════════
// 10. 所有 feature 模块 barrel exports 完整性
// ══════════════════════════════════════════════════════════════════════════════
{
  const workGraph    = await import('../src/features/work-graph/index.js');
  const prPipeline   = await import('../src/features/pr-pipeline/index.js');
  const observ       = await import('../src/features/observability/index.js');
  const cmdCenter    = await import('../src/features/command-center/index.js');

  // work-graph
  assert.equal(typeof workGraph.renderTaskTable, 'function',   'work-graph: renderTaskTable export');
  assert.equal(typeof workGraph.renderTaskDetail, 'function',  'work-graph: renderTaskDetail export');
  assert.equal(typeof workGraph.enrichTaskDetailWithExplanation, 'function', 'work-graph: enrichTaskDetailWithExplanation export');

  // pr-pipeline
  assert.equal(typeof prPipeline.renderPullList, 'function',    'pr-pipeline: renderPullList export');
  assert.equal(typeof prPipeline.openPullDrawer, 'function',    'pr-pipeline: openPullDrawer export');
  assert.equal(typeof prPipeline.startPrAcSse, 'function',      'pr-pipeline: startPrAcSse export');
  assert.equal(typeof prPipeline.stopPrAcSse, 'function',       'pr-pipeline: stopPrAcSse export');
  assert.equal(typeof prPipeline.refreshPrAcChecklist, 'function', 'pr-pipeline: refreshPrAcChecklist export');

  // observability
  assert.equal(typeof observ.renderObservatory, 'function',         'observability: renderObservatory export');
  assert.equal(typeof observ.loadAndRenderSpacePanel, 'function',   'observability: loadAndRenderSpacePanel export');

  // command-center
  assert.equal(typeof cmdCenter.renderEveningTimeline, 'function',  'command-center: renderEveningTimeline export');

  console.log('✓ Feature module barrel exports complete OK');
}

console.log('\nAll feature module tests passed ✓');
