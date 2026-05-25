# Work Graph + PR Pipeline 模块化重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Work Graph（任务/分配/阶段）和 PR Pipeline（PR 列表/Drawer/人工决策）从 `src/app.js` 的大文件结构中拆成真正以 feature 为边界的模块，每个 slice 都有测试、不破坏现有 UI。

**Architecture:** 提取 render 函数和事件绑定到 `src/features/work-graph/` 和 `src/features/pr-pipeline/`，通过已有的 `pullStore`/`taskStore` 传递状态，`src/app.js` 缩减为调用 feature 模块的薄协调层。每步保持浏览器行为不变。

**Tech Stack:** Vanilla ES Modules，Node.js 测试（无浏览器），`pullsApi`/`tasksApi`/`appStateApi`（已建立的 domain API），`pullStore`/`taskStore`/`selectors.js`（已建立的 store）。

---

## 文件结构

**新建：**
- `src/features/pr-pipeline/renderPullList.js` — PR 列表渲染，从 `src/app.js:3335-3370` 提取
- `src/features/pr-pipeline/PullDrawer.js` — PR Drawer 逻辑，从 `src/app.js:3369-3450` 提取
- `src/features/pr-pipeline/index.js` — feature 入口（re-export + 注册 window globals）
- `src/features/work-graph/renderTaskTable.js` — 任务列表渲染，从 `src/app.js:1551-1600` 提取
- `src/features/work-graph/renderTaskDetail.js` — 任务详情，从 `src/app.js:2261-2330` 提取
- `src/features/work-graph/index.js` — feature 入口

**修改：**
- `src/app.js` — 删除被提取的函数，改为 import feature 模块并调用
- `scripts/test-frontend-stores.mjs` — 追加 PR Pipeline + Work Graph 的 store 行为测试
- `scripts/test-frontend-contracts.mjs` — 追加 feature 模块不直接调用 `fetch()` 的契约测试

---

## Task 1：PR Pipeline — renderPullList 提取

**Files:**
- Create: `src/features/pr-pipeline/renderPullList.js`
- Modify: `src/app.js:3335-3370`
- Test: `scripts/test-frontend-stores.mjs`（追加 pull store 渲染准备测试）

- [ ] **Step 1: 追加 pull store 测试（先写失败测试）**

在 `scripts/test-frontend-stores.mjs` 末尾追加：

```js
// PR Pipeline: pull store 渲染准备
import { mergePull, applyPrReviewEvent } from '../src/state/pullStore.js';

{
  const pulls = [];
  const updated = mergePull(pulls, { id: 'pr_1', title: 'feat: add login', state: 'open', number: 42 });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].title, 'feat: add login');

  const updated2 = mergePull(updated, { id: 'pr_1', title: 'feat: add login v2' });
  assert.equal(updated2.length, 1);
  assert.equal(updated2[0].title, 'feat: add login v2');

  const withEvent = applyPrReviewEvent(updated2, {
    pullId: 'pr_1',
    complianceDelta: { 'CI 通过': true },
  });
  assert.deepEqual(withEvent[0].realtimeCompliance, { 'CI 通过': true });

  console.log('PR Pipeline store tests OK');
}
```

- [ ] **Step 2: 确认测试通过**

```bash
node scripts/test-frontend-stores.mjs
```
Expected: `PR Pipeline store tests OK`

- [ ] **Step 3: 创建 renderPullList.js**

```js
// src/features/pr-pipeline/renderPullList.js
// PR 列表渲染 — 从 src/app.js 提取
// 依赖：pullsApi（数据加载），state.pulls（当前列表），openPullDrawer（drawer 触发）

import { pullsApi } from '../../api/pullsApi.js';

export function renderPullList(state, { openPullDrawer, escapeHtml }) {
  const container = document.getElementById('pullList');
  if (!container) return;
  const pulls = state.pulls || [];
  if (!pulls.length) {
    container.innerHTML = '<div class="empty-hint">暂无 PR 数据。请先同步 GitHub 项目。</div>';
    return;
  }
  container.innerHTML = pulls.map((pr) => {
    const stateLabel = { open: '待合并', merged: '已合并', closed: '已关闭' }[pr.state] || pr.state;
    const compliance = pr.hubReview?.compliance || pr.prAgentReview?.compliance;
    const passCount = compliance ? Object.values(compliance).filter(Boolean).length : null;
    const totalCount = compliance ? Object.keys(compliance).length : null;
    const complianceStr = compliance ? `${passCount}/${totalCount} 项通过` : '';
    return `
      <div class="pull-card" onclick="openPullDrawer('${escapeHtml(pr.id)}')">
        <div class="pull-card-head">
          <span class="pull-number">#${pr.number}</span>
          <span class="pull-title">${escapeHtml(pr.title || '(无标题)')}</span>
          <span class="pull-state pull-state-${pr.state}">${stateLabel}</span>
        </div>
        ${complianceStr ? `<div class="pull-compliance-hint">${escapeHtml(complianceStr)}</div>` : ''}
      </div>`;
  }).join('');
}

export async function loadAndRenderPullList(state, params, helpers) {
  const data = await pullsApi.listPulls(Object.fromEntries(params));
  state.pulls = data.pulls || data;
  renderPullList(state, helpers);
  return state.pulls;
}
```

- [ ] **Step 4: 更新 app.js — 用 feature 模块替换原函数**

找到 `src/app.js` 第 3335 行的 `function renderPullList()` 定义，替换为 import 调用：

在文件顶部 import 区追加：
```js
import { renderPullList as _renderPullList, loadAndRenderPullList as _loadPullList } from './features/pr-pipeline/renderPullList.js';
```

将 `function renderPullList()` 整块（约 3335-3370 行）替换为：
```js
function renderPullList() {
  _renderPullList(state, { openPullDrawer, escapeHtml });
}
```

找到原来直接调用 `pullsApi.listPulls` 的地方（约 3324 行），改为：
```js
const pulls = await _loadPullList(state, params, { openPullDrawer, escapeHtml });
```

- [ ] **Step 5: 语法检查 + 测试**

```bash
node --check src/features/pr-pipeline/renderPullList.js src/app.js
node scripts/test-frontend-contracts.mjs
node scripts/test-frontend-stores.mjs
```
Expected: 全部 OK，无报错

- [ ] **Step 6: Commit**

```bash
git add src/features/pr-pipeline/renderPullList.js src/app.js scripts/test-frontend-stores.mjs
git commit -m "refactor: 提取 renderPullList 到 pr-pipeline feature 模块"
```

---

## Task 2：PR Pipeline — PullDrawer 提取

**Files:**
- Create: `src/features/pr-pipeline/PullDrawer.js`
- Modify: `src/app.js:3369-3450`

- [ ] **Step 1: 创建 PullDrawer.js**

```js
// src/features/pr-pipeline/PullDrawer.js
// PR Drawer 逻辑（打开/关闭/渲染详情/提交决策）

import { pullsApi } from '../../api/pullsApi.js';
import { mergePull } from '../../state/pullStore.js';

export function openPullDrawer(pullId, state, { escapeHtml }) {
  const pulls = state.pulls || [];
  const pr = pulls.find((p) => p.id === pullId);
  if (!pr) return;

  const drawer   = document.getElementById('pullDrawer');
  const backdrop = document.getElementById('pullDrawerBackdrop');
  const title    = document.getElementById('pullDrawerTitle');
  const body     = document.getElementById('pullDrawerBody');
  if (!drawer) return;

  title.textContent = `#${pr.number} ${pr.title || '(无标题)'}`;

  const compliance = pr.hubReview?.compliance || pr.prAgentReview?.compliance || {};
  const realtimeCompliance = pr.realtimeCompliance || {};
  const merged = { ...compliance, ...realtimeCompliance };
  const checklistHtml = Object.entries(merged).length
    ? `<ul class="ac-checklist">${Object.entries(merged).map(([k, v]) =>
        `<li class="${v ? 'ac-pass' : 'ac-fail'}">${escapeHtml(k)}</li>`
      ).join('')}</ul>`
    : '<p class="drawer-empty">暂无验收清单</p>';

  body.innerHTML = `
    <div class="drawer-section">
      <h4>验收清单</h4>
      ${checklistHtml}
    </div>
    <div class="drawer-section">
      <h4>人工决策</h4>
      <div class="decision-row">
        <button class="btn btn-success" data-action="pr-decision" data-pull-id="${escapeHtml(pullId)}" data-decision="approve">✅ 通过</button>
        <button class="btn btn-danger"  data-action="pr-decision" data-pull-id="${escapeHtml(pullId)}" data-decision="request-changes">❌ 需修改</button>
      </div>
    </div>`;

  drawer.classList.remove('hidden');
  backdrop.classList.remove('hidden');
}

export function closePullDrawer() {
  document.getElementById('pullDrawer')?.classList.add('hidden');
  document.getElementById('pullDrawerBackdrop')?.classList.add('hidden');
}

export async function submitPullDecision(pullId, decision, state) {
  const data = await pullsApi.submitDecision(pullId, decision);
  state.pulls = mergePull(state.pulls || [], { id: pullId, humanDecision: decision, ...data });
  closePullDrawer();
  return data;
}
```

- [ ] **Step 2: 更新 app.js — 替换 openPullDrawer / closePullDrawer / submitDecision**

在 import 区追加：
```js
import { openPullDrawer as _openPullDrawer, closePullDrawer as _closePullDrawer, submitPullDecision as _submitPullDecision } from './features/pr-pipeline/PullDrawer.js';
```

将 `function openPullDrawer(pullId)` 整块替换为：
```js
function openPullDrawer(pullId) { _openPullDrawer(pullId, state, { escapeHtml }); }
```

将 `function closePullDrawer()` / `closePullDrawer` 调用替换为 `_closePullDrawer()`。

找到 `pullsApi.submitDecision(pullId, decision)` 的调用（约 3441 行），改为：
```js
await _submitPullDecision(pullId, decision, state);
```

- [ ] **Step 3: 确保 window global 仍然可用**

`openPullDrawer` 被 inline onclick 调用，必须保持 window 全局。确认 app.js 中仍有：
```js
window.openPullDrawer = openPullDrawer;
```
（原来已有，不需要改动）

- [ ] **Step 4: 语法检查**

```bash
node --check src/features/pr-pipeline/PullDrawer.js src/app.js
```
Expected: 无报错

- [ ] **Step 5: Commit**

```bash
git add src/features/pr-pipeline/PullDrawer.js src/app.js
git commit -m "refactor: 提取 PullDrawer 到 pr-pipeline feature 模块"
```

---

## Task 3：PR Pipeline — feature 入口 + 契约测试

**Files:**
- Create: `src/features/pr-pipeline/index.js`
- Modify: `scripts/test-frontend-contracts.mjs`

- [ ] **Step 1: 创建 index.js**

```js
// src/features/pr-pipeline/index.js
export { renderPullList, loadAndRenderPullList } from './renderPullList.js';
export { openPullDrawer, closePullDrawer, submitPullDecision } from './PullDrawer.js';
```

- [ ] **Step 2: 追加契约测试**

在 `scripts/test-frontend-contracts.mjs` 末尾追加：

```js
// PR Pipeline: feature 模块不直接调用 fetch()
import { readFileSync } from 'fs';

for (const featureFile of [
  'src/features/pr-pipeline/renderPullList.js',
  'src/features/pr-pipeline/PullDrawer.js',
]) {
  const src = readFileSync(featureFile, 'utf8');
  const directFetch = /\bfetch\s*\(/.test(src);
  assert(!directFetch, `${featureFile} should not call fetch() directly — use pullsApi`);
}
console.log('PR Pipeline contract tests OK');
```

- [ ] **Step 3: 运行全部前端测试**

```bash
node scripts/test-frontend-contracts.mjs
node scripts/test-frontend-stores.mjs
node scripts/test-frontend-api-client.mjs
```
Expected: 全部 OK

- [ ] **Step 4: Commit**

```bash
git add src/features/pr-pipeline/index.js scripts/test-frontend-contracts.mjs
git commit -m "feat: pr-pipeline feature 入口 + 契约测试（无直接 fetch）"
```

---

## Task 4：Work Graph — renderTaskTable 提取

**Files:**
- Create: `src/features/work-graph/renderTaskTable.js`
- Modify: `src/app.js:1551-1600`
- Test: `scripts/test-frontend-stores.mjs`（追加 task store 测试）

- [ ] **Step 1: 追加 task store 测试**

在 `scripts/test-frontend-stores.mjs` 末尾追加：

```js
import { mergeTask, upsertTasks } from '../src/state/taskStore.js';

{
  const tasks = [{ id: 't1', title: '任务A', state: 'pending', risk: '高' }];
  const updated = mergeTask(tasks, { id: 't1', state: 'in_progress' });
  assert.equal(updated[0].state, 'in_progress');
  assert.equal(updated[0].title, '任务A'); // 合并保留原有字段

  const added = mergeTask(tasks, { id: 't2', title: '任务B', state: 'pending', risk: '中' });
  assert.equal(added.length, 2);

  const batch = upsertTasks(tasks, [
    { id: 't1', risk: '低' },
    { id: 't3', title: '任务C', state: 'done', risk: '低' },
  ]);
  assert.equal(batch.length, 2); // t1 + t3
  assert.equal(batch.find((t) => t.id === 't1').risk, '低');

  console.log('Work Graph store tests OK');
}
```

- [ ] **Step 2: 确认测试通过**

```bash
node scripts/test-frontend-stores.mjs
```
Expected: `Work Graph store tests OK`

- [ ] **Step 3: 创建 renderTaskTable.js**

```js
// src/features/work-graph/renderTaskTable.js
// 任务列表渲染（任务板 overview 5条 + 详细任务表）— 从 src/app.js 提取

export function renderTaskTable(state, { escapeHtml }) {
  const table = document.querySelector('#taskTable');
  if (!table) return;
  if (!state.tasks?.length) {
    table.innerHTML = '<div class="empty-state">暂无任务。可以从 AI 排期生成任务，或手动新增。</div>';
    return;
  }

  const riskWeight = { 高: 3, 中: 2, 低: 1 };
  const overviewTasks = [...state.tasks]
    .sort((a, b) =>
      (riskWeight[b.risk] || 0) - (riskWeight[a.risk] || 0) ||
      new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
    )
    .slice(0, 5);

  const stateLabel = { pending: '待领取', claimed: '已领取', in_progress: '进行中', in_review: '审阅中', merged: '已合并', done: '完成', cancelled: '取消' };
  const riskColor  = { 高: '#b42318', 中: '#9a6400', 低: '#0f7a55' };

  table.innerHTML = overviewTasks.map((task) => `
    <div class="task-row" data-task-id="${escapeHtml(task.id)}">
      <div class="task-row-left">
        <span class="task-risk-dot" style="background:${riskColor[task.risk] || '#aaa'}"></span>
        <span class="task-title">${escapeHtml(task.title)}</span>
      </div>
      <div class="task-row-right">
        <span class="task-state-badge">${stateLabel[task.state] || task.state}</span>
        <span class="task-owner">${escapeHtml(task.owner || task.actor_id || '—')}</span>
      </div>
    </div>`).join('');
}
```

- [ ] **Step 4: 更新 app.js**

在 import 区追加：
```js
import { renderTaskTable as _renderTaskTable } from './features/work-graph/renderTaskTable.js';
```

将 `function renderTasks()` 整块替换为：
```js
function renderTasks() { _renderTaskTable(state, { escapeHtml }); }
```

- [ ] **Step 5: 语法检查**

```bash
node --check src/features/work-graph/renderTaskTable.js src/app.js
```

- [ ] **Step 6: Commit**

```bash
git add src/features/work-graph/renderTaskTable.js src/app.js scripts/test-frontend-stores.mjs
git commit -m "refactor: 提取 renderTaskTable 到 work-graph feature 模块"
```

---

## Task 5：Work Graph — renderTaskDetail 提取

**Files:**
- Create: `src/features/work-graph/renderTaskDetail.js`
- Modify: `src/app.js:2261-2330`

- [ ] **Step 1: 读取原函数范围**

```bash
grep -n "^function renderTaskDetail\|^async function renderTaskDetail" src/app.js
```
记录起始行号，查看结束行（下一个同级 function）。

- [ ] **Step 2: 创建 renderTaskDetail.js**

```js
// src/features/work-graph/renderTaskDetail.js
// 任务详情面板渲染（AC 清单、风险、推荐块）— 从 src/app.js 提取

export function renderTaskDetail(state, { escapeHtml, renderTaskRecommendationBlock }) {
  const panel = document.querySelector('#taskDetailPanel');
  if (!panel) return;

  const taskId = state.selectedTaskId;
  const task = (state.tasks || []).find((t) => t.id === taskId);
  if (!task) {
    panel.innerHTML = '<div class="detail-empty">选择任务查看详情</div>';
    return;
  }

  const riskColor = { 高: '#b42318', 中: '#9a6400', 低: '#0f7a55' }[task.risk] || '#888';
  const acItems = (task.acceptance || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  panel.innerHTML = `
    <div class="task-detail-header">
      <h3>${escapeHtml(task.title)}</h3>
      <span class="task-risk-tag" style="color:${riskColor}">${task.risk || '—'} 风险</span>
    </div>
    ${acItems.length ? `
      <div class="task-detail-section">
        <h4>验收清单</h4>
        <ul>${acItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      </div>` : ''}
    <div class="task-detail-section">
      <h4>状态</h4>
      <p>${escapeHtml(task.state || '—')}</p>
    </div>
    ${renderTaskRecommendationBlock ? renderTaskRecommendationBlock(state.taskExplanation) : ''}
  `;
}
```

- [ ] **Step 3: 更新 app.js**

在 import 区追加：
```js
import { renderTaskDetail as _renderTaskDetail } from './features/work-graph/renderTaskDetail.js';
```

将 `function renderTaskDetail()` 整块替换为：
```js
function renderTaskDetail() {
  _renderTaskDetail(state, { escapeHtml, renderTaskRecommendationBlock });
}
```

- [ ] **Step 4: 语法检查**

```bash
node --check src/features/work-graph/renderTaskDetail.js src/app.js
```

- [ ] **Step 5: Commit**

```bash
git add src/features/work-graph/renderTaskDetail.js src/app.js
git commit -m "refactor: 提取 renderTaskDetail 到 work-graph feature 模块"
```

---

## Task 6：Work Graph — feature 入口 + 契约测试

**Files:**
- Create: `src/features/work-graph/index.js`
- Modify: `scripts/test-frontend-contracts.mjs`

- [ ] **Step 1: 创建 index.js**

```js
// src/features/work-graph/index.js
export { renderTaskTable } from './renderTaskTable.js';
export { renderTaskDetail } from './renderTaskDetail.js';
```

- [ ] **Step 2: 追加契约测试**

在 `scripts/test-frontend-contracts.mjs` 末尾追加：

```js
// Work Graph: feature 模块不直接调用 fetch()
for (const featureFile of [
  'src/features/work-graph/renderTaskTable.js',
  'src/features/work-graph/renderTaskDetail.js',
]) {
  const src = readFileSync(featureFile, 'utf8');
  assert(!/\bfetch\s*\(/.test(src), `${featureFile} should not call fetch() directly`);
  assert(!/\/api\//.test(src),      `${featureFile} should not reference /api/ paths directly`);
}
console.log('Work Graph contract tests OK');
```

- [ ] **Step 3: 运行全部测试**

```bash
node scripts/test-frontend-contracts.mjs
node scripts/test-frontend-stores.mjs
node scripts/test-frontend-api-client.mjs
node scripts/test-frontend-app-flow.mjs
```
Expected: 全部 OK

- [ ] **Step 4: Commit**

```bash
git add src/features/work-graph/index.js scripts/test-frontend-contracts.mjs
git commit -m "feat: work-graph feature 入口 + 契约测试"
```

---

## Task 7：npm run check 全量验证 + 推送

**Files:**
- Modify: `package.json`（如有遗漏的 `--check` 路径）

- [ ] **Step 1: 确认 package.json check 脚本已包含新文件**

```bash
grep "work-graph\|pr-pipeline" package.json
```

如果没有，在 `check` 脚本里追加（在现有 `--check src/app.js` 后）：
```
&& node --check src/features/pr-pipeline/renderPullList.js \
&& node --check src/features/pr-pipeline/PullDrawer.js \
&& node --check src/features/pr-pipeline/index.js \
&& node --check src/features/work-graph/renderTaskTable.js \
&& node --check src/features/work-graph/renderTaskDetail.js \
&& node --check src/features/work-graph/index.js
```

- [ ] **Step 2: 运行 npm run check**

```bash
npm run check 2>&1 | tail -20
```
Expected: 最后一行 `All tests passed` 或无 Error 输出，退出码 0。

- [ ] **Step 3: 推送**

```bash
git push origin main
```

---

## 验收清单

- [ ] `src/features/pr-pipeline/` 有 3 个 JS 文件（renderPullList, PullDrawer, index）
- [ ] `src/features/work-graph/` 有 3 个 JS 文件（renderTaskTable, renderTaskDetail, index）
- [ ] `src/app.js` 中的 `renderPullList`、`openPullDrawer`、`closePullDrawer`、`renderTasks`、`renderTaskDetail` 均已缩减为 1-2 行包装调用
- [ ] feature 模块内无 `fetch()` 直接调用（契约测试保证）
- [ ] feature 模块内无 `/api/` 路径字符串（契约测试保证）
- [ ] 4 个前端测试套件全部通过
- [ ] `npm run check` 退出码 0
- [ ] 浏览器 PR 列表、Drawer、任务列表、任务详情行为与重构前一致
