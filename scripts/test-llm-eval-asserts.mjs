/**
 * test-llm-eval-asserts.mjs
 * golden eval「断言侧」的纯逻辑回归 —— 只 import eval/llm-regression/asserts/invariants.mjs，
 * 不碰服务链 / SQLite / promptfoo / 网络，因此可离线、可进 CI（被 run-unit-tests 自动发现）。
 *
 * 注意：这测的是「不变量断言本身对不对」（golden 集的期望侧）。
 * 端到端的真实 LLM 漂移检测在 `npm run eval:llm`（需真实终端 + SQLite，见 eval/llm-regression/README.md）。
 */
import assert from 'node:assert/strict';
import { clarifyValid, gapValid, planValid } from '../eval/llm-regression/asserts/invariants.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}
const J = (o) => JSON.stringify(o);

// ── clarify（L1：3–5 个澄清问题）────────────────────────────────────────────
test('clarify 3 问 → pass', () => {
  assert.equal(clarifyValid(J({ clarificationQuestions: ['a', 'b', 'c'] })).pass, true);
});
test('clarify 5 问 → pass', () => {
  assert.equal(clarifyValid(J({ clarificationQuestions: ['a', 'b', 'c', 'd', 'e'] })).pass, true);
});
test('clarify 2 问（太少）→ fail', () => {
  assert.equal(clarifyValid(J({ clarificationQuestions: ['a', 'b'] })).pass, false);
});
test('clarify 6 问（太多）→ fail', () => {
  assert.equal(clarifyValid(J({ clarificationQuestions: ['a', 'b', 'c', 'd', 'e', 'f'] })).pass, false);
});
test('clarify 非数组 → fail', () => {
  assert.equal(clarifyValid(J({ clarificationQuestions: 'x' })).pass, false);
});
test('clarify 含空问题项 → fail', () => {
  assert.equal(clarifyValid(J({ clarificationQuestions: ['a', '  ', 'c'] })).pass, false);
});
test('clarify 非法 JSON → fail', () => {
  assert.equal(clarifyValid('not json').pass, false);
});

// ── gap（T13：covered/missing 数组 + riskLevel/source 枚举 + 跳过合法）──────────
test('gap 完整 llm 结果 → pass', () => {
  assert.equal(gapValid(J({ covered: ['x'], missing: [], riskLevel: 'medium', source: 'llm' })).pass, true);
});
test('gap 降级 unknown/fallback → pass', () => {
  assert.equal(gapValid(J({ covered: [], missing: [], riskLevel: 'unknown', source: 'fallback' })).pass, true);
});
test('gap 合法跳过（无 acceptance）→ pass', () => {
  assert.equal(gapValid(J({ skipped: true, reason: 'no-acceptance' })).pass, true);
});
test('gap 非法 riskLevel → fail', () => {
  assert.equal(gapValid(J({ covered: [], missing: [], riskLevel: 'severe', source: 'llm' })).pass, false);
});
test('gap 非法 source → fail', () => {
  assert.equal(gapValid(J({ covered: [], missing: [], riskLevel: 'low', source: 'guess' })).pass, false);
});
test('gap 缺 covered/missing 数组 → fail', () => {
  assert.equal(gapValid(J({ riskLevel: 'low', source: 'llm' })).pass, false);
});

// ── plan（L2：3–6 任务 + 有 title + acceptance≠description）────────────────────
test('plan 4 任务 → pass', () => {
  assert.equal(planValid(J([{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }])).pass, true);
});
test('plan 2 任务（太少）→ fail', () => {
  assert.equal(planValid(J([{ title: 'a' }, { title: 'b' }])).pass, false);
});
test('plan 7 任务（太多）→ fail', () => {
  assert.equal(planValid(J(Array.from({ length: 7 }, (_, i) => ({ title: `t${i}` })))).pass, false);
});
test('plan acceptance===description（L2 硬伤）→ fail', () => {
  assert.equal(planValid(J([{ title: 'a', acceptance: 'x', description: 'x' }, { title: 'b' }, { title: 'c' }])).pass, false);
});
test('plan 缺 title → fail', () => {
  assert.equal(planValid(J([{}, { title: 'b' }, { title: 'c' }])).pass, false);
});
test('plan 非数组 → fail', () => {
  assert.equal(planValid(J({ title: 'a' })).pass, false);
});

console.log(`\n${passed + failed} 个测试，${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
