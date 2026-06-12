/**
 * test-l1-frontend.mjs — L1 前端纯逻辑测试（无 DOM，无 SQLite）
 * 覆盖：prdApi 信封解包 + 请求构造；prdView 纯渲染函数
 */
import { strict as assert } from 'assert';
import { createPrdApi } from '../src/api/prdApi.js';

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
  assert.equal(r.length, 1);
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
