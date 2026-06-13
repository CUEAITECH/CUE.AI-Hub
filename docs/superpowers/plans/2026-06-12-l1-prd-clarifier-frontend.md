# L1 需求澄清前端模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `#ai-pm` 页加一个"需求澄清"Tab，用手风琴三步流程跑通 `clarify → generate-prd → refine`，让团队在浏览器里真实验证 SPEC-L1。

**Architecture:** 纯数据层 `prdApi.js`（封装 4 个后端调用 + 解包响应）+ 纯渲染层 `prdView.js`（无 DOM 依赖的 HTML 构建/数据收集函数，可 node 单测）+ DOM 接线层 `prdClarifierPanel.js`（手风琴状态机 + 事件绑定）。PRD 数据只存模块私有变量，不进全局 `state`。

**Tech Stack:** 浏览器原生 ESM（无打包），后端 Node http + Fastify bridge，node 自带 `assert` 跑纯逻辑测试。

> **对 spec 的一处细化**：设计文档把 UI 逻辑都放在 `prdClarifierPanel.js`。本计划把"无 DOM 依赖的纯渲染/数据收集"拆到独立的 `prdView.js`，以便用 node 单测覆盖（接线层仍靠浏览器手测）。文件职责更聚焦。

---

## File Structure

**Create:**
- `src/api/prdApi.js` — 4 个后端调用封装，工厂 + 单例，负责解包 `{ prd }`/`{ prds }` 信封
- `src/features/ai-pm/prdView.js` — 纯函数：`escapeHtml` / `collectAnswers` / `buildQuestionsHtml` / `buildPrdCardHtml`，不碰 `document`
- `src/features/ai-pm/prdClarifierPanel.js` — `initPrdClarifierPanel()`：手风琴状态机 + 事件绑定 + 调用 prdApi/prdView
- `scripts/test-l1-frontend.mjs` — node 测试：prdApi（注入假 client）+ prdView 纯函数

**Modify:**
- `index.html` — `#ai-pm` section 顶部加 Tab 栏；现有规划内容包进 `#aipmTabPlanning`；新增 `#aipmTabClarifier` 手风琴骨架
- `src/app.js` — import `initPrdClarifierPanel`；`setRoute('ai-pm')` 时调用一次（幂等）
- `src/styles.css` — Tab 栏 + 手风琴 + PRD 卡片样式

---

## Task 1: prdApi.js — 数据层（TDD）

**Files:**
- Create: `src/api/prdApi.js`
- Test: `scripts/test-l1-frontend.mjs`

后端响应信封（已核对 `server/routes/planningRoutes.js:439-504`）：
- `POST /api/ai/clarify` → 裸返回 `{ clarificationQuestions[], initialUnderstanding }`
- `POST /api/ai/generate-prd` → `{ prd }`（201）
- `PATCH /api/prd/:id` → `{ prd }`（200）
- `GET /api/prds` → `{ prds }`

路径用 `/api/...`，由 `httpClient.toV2RequestPath` 自动映射到 `/v2/app/...`（与 app.js 现有 `api()` 行为一致）。

- [ ] **Step 1: 写失败测试（prdApi）**

把下面内容写入 `scripts/test-l1-frontend.mjs`（先只放 prdApi 部分，Task 2 再追加 prdView 部分）：

```javascript
/**
 * test-l1-frontend.mjs — L1 前端纯逻辑测试（无 DOM，无 SQLite）
 * 覆盖：prdApi 信封解包 + 请求构造；prdView 纯渲染函数
 */
import { strict as assert } from 'assert';
import { createPrdApi } from '../src/api/prdApi.js';

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); passed++; }
  catch (e) { results.push(`  ✗ ${name}: ${e.message}`); failed++; }
}

// ── 假 client：记录最后一次请求，返回预设 payload ──────────────────
function fakeClient(payload) {
  const calls = [];
  return {
    calls,
    request(path, options = {}) {
      calls.push({ path, method: options.method || 'GET', body: options.body });
      return Promise.resolve(payload);
    },
  };
}

// ── prdApi.clarify：裸返回，原样透传 ──────────────────────────────
test('clarify 发 POST /api/ai/clarify 且 body 含 input', async () => {
  const client = fakeClient({ clarificationQuestions: ['Q1', 'Q2'], initialUnderstanding: 'U' });
  const api = createPrdApi(client);
  const r = await api.clarify('做个打标签功能');
  const last = client.calls.at(-1);
  assert.equal(last.path, '/api/ai/clarify');
  assert.equal(last.method, 'POST');
  assert.deepEqual(JSON.parse(last.body), { input: '做个打标签功能' });
  assert.deepEqual(r.clarificationQuestions, ['Q1', 'Q2']);
});

// ── prdApi.generatePrd：解包 { prd } ──────────────────────────────
test('generatePrd 解包 { prd } 并透传 input/answers', async () => {
  const client = fakeClient({ prd: { id: 'prd_abc', goal: 'G' } });
  const api = createPrdApi(client);
  const r = await api.generatePrd('想法', { Q1: 'A1' });
  const last = client.calls.at(-1);
  assert.equal(last.path, '/api/ai/generate-prd');
  assert.equal(last.method, 'POST');
  assert.deepEqual(JSON.parse(last.body), { input: '想法', answers: { Q1: 'A1' } });
  assert.equal(r.id, 'prd_abc'); // 已解包，不是 { prd: {...} }
});

// ── prdApi.refinePrd：PATCH /api/prd/:id，解包 { prd } ────────────
test('refinePrd 发 PATCH /api/prd/:id 且解包 { prd }', async () => {
  const client = fakeClient({ prd: { id: 'prd_abc', goal: 'G2' } });
  const api = createPrdApi(client);
  const r = await api.refinePrd('prd_abc', '扩大范围');
  const last = client.calls.at(-1);
  assert.equal(last.path, '/api/prd/prd_abc');
  assert.equal(last.method, 'PATCH');
  assert.deepEqual(JSON.parse(last.body), { feedback: '扩大范围' });
  assert.equal(r.goal, 'G2');
});

// ── prdApi.listPrds：解包 { prds } ───────────────────────────────
test('listPrds 解包 { prds } 数组', async () => {
  const client = fakeClient({ prds: [{ id: 'prd_1' }] });
  const api = createPrdApi(client);
  const r = await api.listPrds();
  assert.equal(client.calls.at(-1).path, '/api/prds');
  assert.equal(r.length, 1);
});

console.log('▶ test-l1-frontend.mjs');
results.forEach((r) => console.log(r));
console.log(`  ${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
process.exit(0);
```

> 注意：上面 `test()` 收的是非 async 函数里调 async api。改为同步包装会丢断言。**用下面的 async 版 harness**——把 `function test(name, fn)` 换成支持 await 的串行执行（见 Step 1b）。

- [ ] **Step 1b: 修正 harness 为串行 async**

把 `scripts/test-l1-frontend.mjs` 顶部的 harness 与执行尾部改成串行 async（替换 Step 1 中的同名片段）：

```javascript
let passed = 0, failed = 0;
const results = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

async function run() {
  for (const { name, fn } of queue) {
    try { await fn(); results.push(`  ✓ ${name}`); passed++; }
    catch (e) { results.push(`  ✗ ${name}: ${e.message}`); failed++; }
  }
  console.log('▶ test-l1-frontend.mjs');
  results.forEach((r) => console.log(r));
  console.log(`  ${passed} 通过，${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}
```

并把文件末尾的 `console.log('▶ ...')...process.exit(...)` 那段删掉，改为最后一行调用 `run();`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test-l1-frontend.mjs`
Expected: FAIL — `Cannot find module '../src/api/prdApi.js'` 或 `createPrdApi is not a function`

- [ ] **Step 3: 实现 prdApi.js**

写入 `src/api/prdApi.js`：

```javascript
import { httpClient } from './httpClient.js';

/**
 * SPEC-L1 数据层：想法澄清 → PRD 生成 → 局部修改。
 * 路径用 /api/*，由 httpClient 自动映射到 /v2/app/*。
 * 解包后端的 { prd } / { prds } 信封，让调用方拿到裸对象。
 */
export function createPrdApi(client = httpClient) {
  return {
    clarify(input) {
      return client.request('/api/ai/clarify', {
        method: 'POST',
        body: JSON.stringify({ input: String(input || '') }),
      });
    },
    async generatePrd(input, answers = {}) {
      const r = await client.request('/api/ai/generate-prd', {
        method: 'POST',
        body: JSON.stringify({ input: String(input || ''), answers: answers || {} }),
      });
      return r.prd;
    },
    async refinePrd(id, feedback) {
      const r = await client.request(`/api/prd/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ feedback: String(feedback || '') }),
      });
      return r.prd;
    },
    async listPrds() {
      const r = await client.request('/api/prds');
      return r.prds || [];
    },
  };
}

export const prdApi = createPrdApi();
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/test-l1-frontend.mjs`
Expected: PASS — 4 通过，0 失败

- [ ] **Step 5: 提交**

```bash
git add src/api/prdApi.js scripts/test-l1-frontend.mjs
git commit -m "feat: L1 前端数据层 prdApi — clarify/generatePrd/refinePrd/listPrds + 信封解包"
```

---

## Task 2: prdView.js — 纯渲染层（TDD）

**Files:**
- Create: `src/features/ai-pm/prdView.js`
- Test: `scripts/test-l1-frontend.mjs`（追加）

纯函数，不碰 `document`：`escapeHtml(s)` / `collectAnswers(questions, values)` / `buildQuestionsHtml(clarifyResult)` / `buildPrdCardHtml(prd)`。

- [ ] **Step 1: 追加失败测试（prdView）**

在 `scripts/test-l1-frontend.mjs` 顶部 import 行后加：

```javascript
import { escapeHtml, collectAnswers, buildQuestionsHtml, buildPrdCardHtml } from '../src/features/ai-pm/prdView.js';
```

在 `run();` 之前追加这些用例：

```javascript
// ── escapeHtml：转义 HTML 特殊字符 ───────────────────────────────
test('escapeHtml 转义尖括号与引号', () => {
  assert.equal(escapeHtml('<b>"&'), '&lt;b&gt;&quot;&amp;');
});

// ── collectAnswers：问题与回答按序配成字典 ───────────────────────
test('collectAnswers 把问题数组 + 回答数组配成 { 问题: 回答 }', () => {
  const r = collectAnswers(['目标用户?', '成功指标?'], ['审核员', '覆盖率>80%']);
  assert.deepEqual(r, { '目标用户?': '审核员', '成功指标?': '覆盖率>80%' });
});

test('collectAnswers 跳过空白回答', () => {
  const r = collectAnswers(['Q1', 'Q2'], ['A1', '   ']);
  assert.deepEqual(r, { Q1: 'A1' });
});

// ── buildQuestionsHtml：每题一个带 data-qi 的 textarea ───────────
test('buildQuestionsHtml 为每个问题生成一个 textarea', () => {
  const html = buildQuestionsHtml({ clarificationQuestions: ['Q1', 'Q2'], initialUnderstanding: '理解X' });
  assert.equal((html.match(/data-qi=/g) || []).length, 2);
  assert.ok(html.includes('理解X'));
});

test('buildQuestionsHtml 转义问题中的 HTML', () => {
  const html = buildQuestionsHtml({ clarificationQuestions: ['<script>'], initialUnderstanding: '' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

// ── buildPrdCardHtml：渲染全部字段，缺失补占位 ───────────────────
test('buildPrdCardHtml 渲染 title/goal/acceptance', () => {
  const html = buildPrdCardHtml({
    title: '视频标签', goal: '让审核员分类',
    acceptance: ['覆盖率>80%', '准确率>90%'],
    scope: ['手动打标'], nonGoals: ['AI 自动'], risks: ['滥用'],
    userStories: [{ id: 'US-001', as: '审核员', want: '打标', so: '检索', acceptance: '可搜' }],
  });
  assert.ok(html.includes('视频标签'));
  assert.ok(html.includes('让审核员分类'));
  assert.ok(html.includes('覆盖率&gt;80%')); // 已转义
  assert.ok(html.includes('US-001'));
});

test('buildPrdCardHtml 字段缺失时用占位不报错', () => {
  const html = buildPrdCardHtml({ title: '', goal: '', acceptance: [], scope: [], nonGoals: [], risks: [], userStories: [] });
  assert.ok(html.includes('—'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test-l1-frontend.mjs`
Expected: FAIL — `Cannot find module '.../prdView.js'`

- [ ] **Step 3: 实现 prdView.js**

写入 `src/features/ai-pm/prdView.js`：

```javascript
/**
 * prdView.js — SPEC-L1 前端纯渲染层（无 DOM 依赖，可 node 单测）。
 * 只做"数据 → HTML 字符串"和"DOM 取值 → 数据"两类纯转换。
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 问题数组 + 回答数组 → { [问题]: 回答 }，跳过空白回答 */
export function collectAnswers(questions, values) {
  const out = {};
  (questions || []).forEach((q, i) => {
    const a = String((values || [])[i] ?? '').trim();
    if (a) out[q] = a;
  });
  return out;
}

/** 渲染澄清问题列表：初步理解 + 每题一个 textarea[data-qi] */
export function buildQuestionsHtml(clarifyResult) {
  const understanding = escapeHtml(clarifyResult?.initialUnderstanding || '');
  const questions = clarifyResult?.clarificationQuestions || [];
  const understandingHtml = understanding
    ? `<p class="l1-understanding">💬 ${understanding}</p>` : '';
  const rows = questions.map((q, i) => `
    <div class="l1-q-row">
      <label class="l1-q-label">${i + 1}. ${escapeHtml(q)}</label>
      <textarea class="l1-q-input" data-qi="${i}" rows="2" placeholder="你的回答…"></textarea>
    </div>`).join('');
  return `${understandingHtml}<div class="l1-q-list">${rows}</div>`;
}

/** 渲染 PRD 卡片：分区字段 + 折叠用户故事 */
export function buildPrdCardHtml(prd) {
  const p = prd || {};
  const list = (arr) => (arr && arr.length)
    ? `<ul class="l1-prd-ul">${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : '<span class="l1-muted">—</span>';
  const story = (s) => `
    <div class="l1-story">
      <strong>${escapeHtml(s.id || 'US')}</strong>
      作为 ${escapeHtml(s.as || '—')}，我想 ${escapeHtml(s.want || '—')}，以便 ${escapeHtml(s.so || '—')}。
      <em>验收：${escapeHtml(s.acceptance || '—')}</em>
    </div>`;
  const stories = (p.userStories && p.userStories.length)
    ? p.userStories.map(story).join('')
    : '<span class="l1-muted">—</span>';
  return `
    <div class="l1-prd-card">
      <div class="l1-prd-row"><span class="l1-prd-k">标题</span><span class="l1-prd-v">${escapeHtml(p.title) || '<span class="l1-muted">—</span>'}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">目标</span><span class="l1-prd-v">${escapeHtml(p.goal) || '<span class="l1-muted">—</span>'}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">验收条件</span><span class="l1-prd-v">${list(p.acceptance)}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">范围</span><span class="l1-prd-v">${list(p.scope)}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">不做</span><span class="l1-prd-v">${list(p.nonGoals)}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">风险</span><span class="l1-prd-v">${list(p.risks)}</span></div>
      <details class="l1-prd-stories"><summary>用户故事（${(p.userStories || []).length}）</summary>${stories}</details>
    </div>`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/test-l1-frontend.mjs`
Expected: PASS — 11 通过，0 失败

- [ ] **Step 5: 提交**

```bash
git add src/features/ai-pm/prdView.js scripts/test-l1-frontend.mjs
git commit -m "feat: L1 前端纯渲染层 prdView — 问题/PRD 卡片 HTML 构建 + 回答收集"
```

---

## Task 3: index.html — Tab 栏 + 手风琴骨架

**Files:**
- Modify: `index.html:396-457`（`#ai-pm` section）

把现有规划内容（`.ai-pm-summary` 到 `.ai-pm-grid` 结束）包进 `#aipmTabPlanning`，并在其后加 `#aipmTabClarifier`。现有 DOM id（`aiPmSummary` 等）保持不变，`renderAiPm()` 不受影响。

- [ ] **Step 1: 加 Tab 栏并包裹规划内容**

在 `index.html` 中，把 `<section class="view" id="ai-pm">` 内的这段：

```html
            <div class="ai-pm-summary" id="aiPmSummary">
```
…到对应的 `.ai-pm-grid` 闭合 `</div>`（第 455 行那个），整体用一个新 div 包起来。

具体做法：在 `</div>`（第 410 行 `.assign-page-header` 闭合）之后、`<div class="ai-pm-summary"` 之前，插入：

```html
            <div class="ai-pm-tabs" id="aipmTabs">
              <button type="button" class="ai-pm-tab active" data-aipm-tab="planning">规划调整</button>
              <button type="button" class="ai-pm-tab" data-aipm-tab="clarifier">需求澄清</button>
            </div>
            <div id="aipmTabPlanning">
```

然后在 `.ai-pm-grid` 的闭合 `</div>`（原第 455 行）之后插入闭合标签 + 澄清 Tab 容器：

```html
            </div><!-- /#aipmTabPlanning -->

            <div id="aipmTabClarifier" hidden>
              <div class="l1-intro">
                <p>描述一个产品想法，AI 先反问澄清，再生成结构化 PRD。</p>
              </div>

              <!-- Step 1：描述想法 -->
              <div class="l1-step l1-step-active" id="l1Step1" data-step="1">
                <div class="l1-step-head">
                  <span class="l1-step-num">1</span>
                  <span class="l1-step-title">描述想法</span>
                  <span class="l1-step-status" id="l1Step1Status">当前步骤</span>
                </div>
                <div class="l1-step-body" id="l1Step1Body">
                  <textarea id="l1Input" class="l1-input" rows="3" placeholder="例：做一个让用户能给视频打标签的功能"></textarea>
                  <div class="l1-step-actions">
                    <button type="button" class="l1-btn" id="l1ClarifyBtn" disabled>开始澄清 →</button>
                  </div>
                  <div class="l1-err" id="l1Step1Err" hidden></div>
                </div>
              </div>

              <!-- Step 2：回答澄清问题 -->
              <div class="l1-step l1-step-locked" id="l1Step2" data-step="2">
                <div class="l1-step-head">
                  <span class="l1-step-num">2</span>
                  <span class="l1-step-title">回答澄清问题</span>
                  <span class="l1-step-status" id="l1Step2Status">等待 Step 1</span>
                </div>
                <div class="l1-step-body" id="l1Step2Body" hidden>
                  <div id="l1Questions"></div>
                  <div class="l1-step-actions">
                    <button type="button" class="l1-btn" id="l1GenerateBtn">生成 PRD →</button>
                  </div>
                  <div class="l1-err" id="l1Step2Err" hidden></div>
                </div>
              </div>

              <!-- Step 3：PRD 预览 + 修改 -->
              <div class="l1-step l1-step-locked" id="l1Step3" data-step="3">
                <div class="l1-step-head">
                  <span class="l1-step-num">3</span>
                  <span class="l1-step-title">PRD 预览 + 修改</span>
                  <span class="l1-step-status" id="l1Step3Status">等待 Step 2</span>
                </div>
                <div class="l1-step-body" id="l1Step3Body" hidden>
                  <div id="l1PrdCard"></div>
                  <div class="l1-refine">
                    <label class="l1-q-label">修改意见（可选）</label>
                    <textarea id="l1Feedback" class="l1-input" rows="2" placeholder="例：把范围扩大到也支持给图片打标签"></textarea>
                    <div class="l1-step-actions">
                      <button type="button" class="l1-btn" id="l1RefineBtn">提交修改</button>
                    </div>
                  </div>
                  <div class="l1-err" id="l1Step3Err" hidden></div>
                </div>
              </div>
            </div><!-- /#aipmTabClarifier -->
```

- [ ] **Step 2: 语法检查**

Run: `npm run check`
Expected: PASS（HTML 不被 check 扫描；此步确认没误删 JS。若 check 仅扫 .js/.mjs 则必 PASS）

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "feat: ai-pm 页加 Tab 栏 + L1 需求澄清手风琴骨架"
```

---

## Task 4: prdClarifierPanel.js — 手风琴接线层

**Files:**
- Create: `src/features/ai-pm/prdClarifierPanel.js`

DOM 接线 + 手风琴状态机。`initPrdClarifierPanel()` 幂等（重复调用只绑定一次事件）。本层靠浏览器手测（Task 6），无 node 单测。

- [ ] **Step 1: 实现 prdClarifierPanel.js**

写入 `src/features/ai-pm/prdClarifierPanel.js`：

```javascript
/**
 * prdClarifierPanel.js — SPEC-L1 前端接线层。
 * 手风琴三步：描述想法 → 回答澄清 → PRD 预览/修改。
 * 数据只存模块私有变量，不进全局 state（单模块功能验证）。
 */
import { prdApi } from '../../api/prdApi.js';
import { collectAnswers, buildQuestionsHtml, buildPrdCardHtml } from './prdView.js';

let _bound = false;
let _input = '';
let _clarifyResult = null;
let _prd = null;

const $ = (id) => document.getElementById(id);

// ── 步骤展开/折叠状态机 ──────────────────────────────────────────
function setStep(n, status /* 'locked' | 'active' | 'done' */) {
  const step = $(`l1Step${n}`);
  const body = $(`l1Step${n}Body`);
  const statusEl = $(`l1Step${n}Status`);
  if (!step || !body) return;
  step.classList.remove('l1-step-locked', 'l1-step-active', 'l1-step-done');
  step.classList.add(`l1-step-${status}`);
  body.hidden = status === 'locked';
  if (statusEl) {
    statusEl.textContent = status === 'active' ? '当前步骤' : status === 'done' ? '已完成 · 点击回看' : statusEl.textContent;
  }
}

function showErr(n, msg) {
  const el = $(`l1Step${n}Err`);
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.textContent = ''; el.hidden = true; }
}

async function withBusy(btn, label, fn) {
  if (!btn) return fn();
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

// ── Step 1 → clarify ─────────────────────────────────────────────
async function onClarify() {
  _input = ($('l1Input')?.value || '').trim();
  if (!_input) return;
  showErr(1, '');
  try {
    _clarifyResult = await withBusy($('l1ClarifyBtn'), '澄清中…', () => prdApi.clarify(_input));
    $('l1Questions').innerHTML = buildQuestionsHtml(_clarifyResult);
    setStep(1, 'done');
    setStep(2, 'active');
  } catch (e) {
    showErr(1, `澄清失败：${e.message}`);
  }
}

// ── Step 2 → generatePrd ─────────────────────────────────────────
async function onGenerate() {
  showErr(2, '');
  const questions = _clarifyResult?.clarificationQuestions || [];
  const values = Array.from(document.querySelectorAll('#l1Questions [data-qi]'))
    .sort((a, b) => Number(a.dataset.qi) - Number(b.dataset.qi))
    .map((el) => el.value);
  const answers = collectAnswers(questions, values);
  try {
    _prd = await withBusy($('l1GenerateBtn'), '生成中…', () => prdApi.generatePrd(_input, answers));
    $('l1PrdCard').innerHTML = buildPrdCardHtml(_prd);
    setStep(2, 'done');
    setStep(3, 'active');
  } catch (e) {
    showErr(2, `生成失败：${e.message}`);
  }
}

// ── Step 3 → refinePrd ───────────────────────────────────────────
async function onRefine() {
  showErr(3, '');
  const feedback = ($('l1Feedback')?.value || '').trim();
  if (!feedback || !_prd?.id) return;
  try {
    _prd = await withBusy($('l1RefineBtn'), '修改中…', () => prdApi.refinePrd(_prd.id, feedback));
    $('l1PrdCard').innerHTML = buildPrdCardHtml(_prd);
    $('l1Feedback').value = '';
  } catch (e) {
    showErr(3, `修改失败：${e.message}`);
  }
}

// ── Tab 切换 ─────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.ai-pm-tab').forEach((b) => b.classList.toggle('active', b.dataset.aipmTab === name));
  const planning = $('aipmTabPlanning');
  const clarifier = $('aipmTabClarifier');
  if (planning) planning.hidden = name !== 'planning';
  if (clarifier) clarifier.hidden = name !== 'clarifier';
}

// ── 点击已完成步骤头 → 展开回看 ──────────────────────────────────
function onStepHeadClick(e) {
  const head = e.target.closest('.l1-step-head');
  if (!head) return;
  const step = head.closest('.l1-step');
  if (!step || !step.classList.contains('l1-step-done')) return;
  const body = step.querySelector('.l1-step-body');
  if (body) body.hidden = !body.hidden;
}

/** 初始化 L1 澄清面板。幂等：事件只绑定一次。 */
export function initPrdClarifierPanel() {
  if (_bound) return;
  if (!$('aipmTabClarifier')) return; // DOM 还没准备好就跳过
  _bound = true;

  $('aipmTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.ai-pm-tab');
    if (tab) switchTab(tab.dataset.aipmTab);
  });

  const input = $('l1Input');
  input?.addEventListener('input', () => {
    const btn = $('l1ClarifyBtn');
    if (btn) btn.disabled = !input.value.trim();
  });

  $('l1ClarifyBtn')?.addEventListener('click', onClarify);
  $('l1GenerateBtn')?.addEventListener('click', onGenerate);
  $('l1RefineBtn')?.addEventListener('click', onRefine);
  $('aipmTabClarifier')?.addEventListener('click', onStepHeadClick);
}
```

- [ ] **Step 2: 语法检查**

Run: `npm run check`
Expected: PASS（新 .js 文件语法正确）

- [ ] **Step 3: 提交**

```bash
git add src/features/ai-pm/prdClarifierPanel.js
git commit -m "feat: L1 澄清面板接线层 prdClarifierPanel — 手风琴状态机 + 三步事件绑定"
```

---

## Task 5: app.js 接线 + styles.css 样式

**Files:**
- Modify: `src/app.js`（顶部 import 区 + `setRoute` 内 ai-pm 分支）
- Modify: `src/styles.css`（追加 L1 样式）

- [ ] **Step 1: app.js 加 import**

在 `src/app.js` 第 17 行 `import { configApi } ...` 之后加：

```javascript
import { initPrdClarifierPanel } from './features/ai-pm/prdClarifierPanel.js';
```

- [ ] **Step 2: app.js 在 ai-pm 路由激活时调用**

在 `setRoute` 函数体内，已有的 `if (route === 'observatory') {...}` 块附近，加一个 ai-pm 分支（紧跟 `if (route === 'reviews') {...}` 之后即可）：

```javascript
  if (route === 'ai-pm') {
    initPrdClarifierPanel();
  }
```

（`initPrdClarifierPanel` 幂等，重复进入 ai-pm 不会重复绑定。）

- [ ] **Step 3: styles.css 追加 L1 样式**

在 `src/styles.css` 末尾追加：

```css
/* ── L1 需求澄清（ai-pm Tab） ──────────────────────────────── */
.ai-pm-tabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(148,163,184,0.18); margin-bottom: 16px; }
.ai-pm-tab { background: none; border: none; padding: 8px 18px; font-size: 13px; color: #94a3b8; cursor: pointer; border-bottom: 2px solid transparent; }
.ai-pm-tab.active { color: #60a5fa; border-bottom-color: #60a5fa; font-weight: 600; }
.l1-intro { color: #94a3b8; font-size: 13px; margin-bottom: 14px; }
.l1-step { border: 1px solid rgba(148,163,184,0.18); border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
.l1-step-active { border-color: rgba(96,165,250,0.4); }
.l1-step-locked { opacity: 0.5; }
.l1-step-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
.l1-step-done .l1-step-head, .l1-step-locked .l1-step-head { cursor: pointer; }
.l1-step-num { width: 22px; height: 22px; border-radius: 50%; background: rgba(148,163,184,0.2); color: #cbd5e1; font-size: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.l1-step-active .l1-step-num { background: #3b82f6; color: #fff; }
.l1-step-done .l1-step-num { background: #22c55e; color: #fff; }
.l1-step-title { font-size: 13px; font-weight: 600; color: #e2e8f0; }
.l1-step-status { margin-left: auto; font-size: 11px; color: #94a3b8; }
.l1-step-body { padding: 0 16px 16px; }
.l1-input { width: 100%; box-sizing: border-box; background: rgba(15,23,42,0.5); border: 1px solid rgba(148,163,184,0.2); border-radius: 8px; padding: 8px 12px; color: #e2e8f0; font-size: 13px; resize: vertical; }
.l1-step-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
.l1-btn { background: #3b82f6; color: #fff; border: none; border-radius: 8px; padding: 7px 16px; font-size: 13px; cursor: pointer; }
.l1-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.l1-err { margin-top: 10px; color: #f87171; font-size: 12px; }
.l1-understanding { color: #cbd5e1; font-size: 13px; margin: 0 0 12px; padding: 8px 12px; background: rgba(96,165,250,0.08); border-radius: 8px; }
.l1-q-row { margin-bottom: 12px; }
.l1-q-label { display: block; font-size: 12px; color: #cbd5e1; margin-bottom: 6px; }
.l1-q-input { width: 100%; box-sizing: border-box; background: rgba(15,23,42,0.5); border: 1px solid rgba(148,163,184,0.2); border-radius: 8px; padding: 7px 11px; color: #e2e8f0; font-size: 13px; resize: vertical; }
.l1-prd-card { background: rgba(15,23,42,0.4); border-radius: 10px; padding: 14px; }
.l1-prd-row { display: grid; grid-template-columns: 84px 1fr; gap: 8px 12px; padding: 6px 0; border-bottom: 1px solid rgba(148,163,184,0.1); }
.l1-prd-k { color: #64748b; font-size: 12px; }
.l1-prd-v { color: #e2e8f0; font-size: 13px; }
.l1-prd-ul { margin: 0; padding-left: 18px; }
.l1-prd-ul li { margin: 2px 0; }
.l1-muted { color: #64748b; }
.l1-prd-stories { margin-top: 10px; }
.l1-prd-stories summary { cursor: pointer; color: #94a3b8; font-size: 12px; }
.l1-story { margin: 8px 0; padding: 8px 12px; background: rgba(148,163,184,0.06); border-radius: 8px; font-size: 12px; color: #cbd5e1; }
.l1-story em { display: block; margin-top: 4px; color: #94a3b8; }
.l1-refine { margin-top: 14px; border-top: 1px solid rgba(148,163,184,0.14); padding-top: 12px; }
```

- [ ] **Step 4: 语法检查**

Run: `npm run check`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/app.js src/styles.css
git commit -m "feat: L1 澄清面板接入 app.js 路由 + 样式（Tab/手风琴/PRD 卡片）"
```

---

## Task 6: 浏览器端到端手测

**Files:** 无（验证步骤）

- [ ] **Step 1: 启动服务**

Run: `npm run dev`
Expected: 终端打印 `http://127.0.0.1:4317`，无报错。若端口被占用，先 `lsof -ti:4317 | xargs kill -9` 清理僵尸进程。

- [ ] **Step 2: 登录并进入 ai-pm 页**

浏览器开 `http://127.0.0.1:4317`，登录后侧边栏点"AI PM"。
Expected: 看到顶部两个 Tab「规划调整 | 需求澄清」，默认显示规划调整（现有内容不变）。

- [ ] **Step 3: 切到需求澄清，跑 Step 1**

点「需求澄清」Tab，输入框填「做一个让用户能给视频打标签的功能」，点「开始澄清」。
Expected: Step 1 折叠变绿（已完成），Step 2 展开，显示 3-5 个澄清问题，每题一个输入框 + 初步理解文案。

- [ ] **Step 4: 跑 Step 2 生成 PRD**

在 Step 2 各问题下填回答，点「生成 PRD」。
Expected: Step 2 折叠，Step 3 展开，PRD 卡片显示 标题/目标/验收条件/范围/不做/风险，且**验收条件 ≠ 目标**（AC-L1-004）；用户故事可点开。

- [ ] **Step 5: 跑 Step 3 局部修改**

修改意见填「把范围扩大到也支持给图片打标签」，点「提交修改」。
Expected: PRD 卡片原地更新，范围里出现图片相关条目，标题/id 不变。

- [ ] **Step 6: 回看与错误态**

点已完成的 Step 1 头部 → 可展开回看输入。临时停服务后点任一按钮 → 对应步骤显示红色错误提示，按钮恢复可点（不卡死）。

- [ ] **Step 7: 跑全量测试确认无回归**

Run: `npm run test:ci`
Expected: PASS（含新增 `scripts/test-l1-frontend.mjs` 的 11 条）。`npm run check` 也应 PASS。

- [ ] **Step 8: 更新 SPEC-L1 实现笔记（前端落地）**

把 `docs/specs/SPEC-L1-clarification.md` 第 7 节"前端（设计中 / 施工日志）"改为"前端（已实现）"，并在 dated 设计文档旁补一行落地说明。提交：

```bash
git add docs/specs/SPEC-L1-clarification.md
git commit -m "docs: SPEC-L1 前端落地，实现笔记更新为已实现"
```

---

## Self-Review

**Spec coverage：**
- 位置=ai-pm Tab → Task 3/4（switchTab）✓
- 手风琴步骤解锁 → Task 4（setStep 状态机）✓
- 单列 PRD 卡片 → Task 2（buildPrdCardHtml）✓
- 局部 state 不进全局 → Task 4（模块私有 `_prd` 等）✓
- 4 个 API + 信封解包 → Task 1 ✓
- 错误处理（API 失败/空输入/防重复提交）→ Task 4（showErr/withBusy/按钮 disabled）✓
- PRD 字段缺失占位 → Task 2（`—` 占位用例）✓
- 测试方式（浏览器端到端 + 对照 mock-exam）→ Task 6 ✓
- listPrds 本期不接 UI 但保留 → Task 1（实现 + 测试，不接线）✓

**Placeholder 扫描：** 无 TODO/TBD；每个 code step 都有完整代码。

**类型一致性：** `createPrdApi`/`prdApi`、`initPrdClarifierPanel`、`escapeHtml`/`collectAnswers`/`buildQuestionsHtml`/`buildPrdCardHtml`、DOM id（`l1Step{n}Body`/`l1Questions`/`l1PrdCard`/`aipmTabPlanning`/`aipmTabClarifier`）在各 Task 间引用一致；`data-qi` 在 prdView 生成、prdClarifierPanel 读取，命名对齐。
