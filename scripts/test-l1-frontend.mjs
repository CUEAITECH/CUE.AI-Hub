/**
 * test-l1-frontend.mjs — L1 前端纯逻辑测试（无 DOM，无 SQLite）
 * 覆盖：prdApi 信封解包 + 请求构造；prdView 纯渲染函数
 */
import { strict as assert } from 'assert';
import { createPrdApi } from '../src/api/prdApi.js';
import { escapeHtml, collectAnswers, buildQuestionsHtml, buildPrdCardHtml } from '../src/features/ai-pm/prdView.js';

let passed = 0, failed = 0;
const results = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

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
  assert.equal(client.calls.at(-1).method, 'GET');
  assert.equal(r.length, 1);
});

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

run();
