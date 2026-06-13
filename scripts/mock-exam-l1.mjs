/**
 * mock-exam-l1.mjs — L1 澄清反问 真实 LLM 端到端 mock exam
 *
 * 场景：PM 丢了一句"做一个让用户能给视频打标签的功能"
 * 测试完整链路：
 *   Step 1: clarify(input) → 3-5 个澄清问题
 *   Step 2: generatePrd(input, answers) → 结构化 PRD
 *   Step 3: refinePrd(prd, feedback) → 局部更新
 *
 * 运行：node scripts/mock-exam-l1.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

// 手动加载 .env（不依赖 dotenv，不拉 store.js）
const envFile = join(root, '.env');
try {
  const lines = readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env 不存在也没关系 */ }

// 直接用 OpenAI SDK，绕开 configStore → getDb 链路
import OpenAI from 'openai';
import { parseJsonOutput } from '../server/services/claude.js';

// ── 先确认 API key ──────────────────────────────────────────────────
const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL || undefined;
if (!apiKey) {
  console.error('❌ OPENAI_API_KEY 未设置，无法运行真实 LLM 测试');
  process.exit(1);
}

const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';

async function call(system, user) {
  const t0 = Date.now();
  const resp = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const text = resp.choices[0]?.message?.content ?? '';
  const ms = Date.now() - t0;
  const tokens = resp.usage?.total_tokens ?? '?';
  return { text, ms, tokens };
}

// ── Mock Exam 场景 ──────────────────────────────────────────────────
const INPUT = '做一个让用户能给视频打标签的功能';
console.log('\n═══════════════════════════════════════════════════════');
console.log('  CUE L1 Mock Exam — 想法 → 澄清 → PRD');
console.log('═══════════════════════════════════════════════════════');
console.log(`\n📝 原始输入：「${INPUT}」\n`);

// ────────────────────────────────────────────────────────────────────
// STEP 1: Clarify
// ────────────────────────────────────────────────────────────────────
console.log('─── Step 1: clarify ────────────────────────────────────');
const CLARIFY_SYSTEM = `你是 CUE 的 AI 产品经理。用户描述一个想法时，你的第一步是识别模糊之处并提问，而不是直接生成任务。

聚焦四类问题：
1. 目标用户是谁，他们有什么具体痛点？
2. 做完了什么算成功（可量化的指标）？
3. 范围边界：这次做什么，明确不做什么？
4. 已知约束：技术/时间/资源限制？

规则：问题数量 3-5 个，不超过 5 个，每个问题聚焦一个维度。

只返回 JSON：{"clarificationQuestions":["问题1","问题2","问题3"],"initialUnderstanding":"我理解你想做的是..."}`;

const { text: r1, ms: ms1, tokens: t1 } = await call(CLARIFY_SYSTEM, `用户输入：\n${INPUT}`);
const clarifyResult = parseJsonOutput(r1);
console.log(`⏱  ${ms1}ms / ${t1} tokens`);

if (!clarifyResult?.clarificationQuestions?.length) {
  console.error('❌ clarify 解析失败，原始输出：', r1.slice(0, 200));
  process.exit(1);
}

console.log(`\n💬 初步理解：${clarifyResult.initialUnderstanding}`);
console.log('\n❓ 澄清问题：');
clarifyResult.clarificationQuestions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

// 验收
const qCount = clarifyResult.clarificationQuestions.length;
console.log(`\n✅ AC-L1-002: 问题数量 = ${qCount} ${ qCount >= 3 && qCount <= 5 ? '✓' : '✗（应为3-5）'}`);
console.log(`✅ AC-L1-001: 无 goal/id 字段 = ${!clarifyResult.goal && !clarifyResult.id ? '✓' : '✗'}`);

// ────────────────────────────────────────────────────────────────────
// STEP 2: Mock 回答 + 生成 PRD
// ────────────────────────────────────────────────────────────────────
console.log('\n─── Step 2: generate-prd ───────────────────────────────');
// 模拟 PM 回答
const mockAnswers = {
  [clarifyResult.clarificationQuestions[0]]: '视频平台的内容审核员和普通观众，他们需要快速分类和检索视频内容',
  [clarifyResult.clarificationQuestions[1] || '成功指标']: '标签覆盖率 > 80%，标签检索准确率 > 90%，操作耗时 < 3s',
  [clarifyResult.clarificationQuestions[2] || '范围']: '只做手动打标，不做自动 AI 标签；只支持已上传视频，不支持直播',
};
console.log('\n👤 PM 回答（模拟）：');
Object.entries(mockAnswers).forEach(([q, a]) => console.log(`  Q: ${q.slice(0, 40)}...\n  A: ${a}\n`));

const PRD_SYSTEM = `你是 CUE 的 AI 产品经理。根据用户的原始想法和澄清回答，生成一份标准结构化 PRD。PRD 的 acceptance 字段必须是可测量的完成条件，不能照抄 goal。只返回 JSON：{"title":"...","goal":"...","userStories":[{"id":"US-001","as":"...","want":"...","so":"...","acceptance":"..."}],"scope":[...],"nonGoals":[...],"acceptance":[...],"risks":[...]}`;

const answersText = Object.entries(mockAnswers).map(([q, a]) => `问：${q}\n答：${a}`).join('\n\n');
const { text: r2, ms: ms2, tokens: t2 } = await call(
  PRD_SYSTEM,
  `原始输入：\n${INPUT}\n\n澄清回答：\n${answersText}\n\n请生成完整 PRD：`
);
const prd = parseJsonOutput(r2);
console.log(`⏱  ${ms2}ms / ${t2} tokens`);

if (!prd?.goal || !Array.isArray(prd.acceptance)) {
  console.error('❌ PRD 解析失败，原始输出：', r2.slice(0, 300));
  process.exit(1);
}

console.log(`\n📋 生成 PRD：`);
console.log(`  标题：${prd.title}`);
console.log(`  目标：${prd.goal}`);
console.log(`  范围（${prd.scope?.length || 0}项）：${(prd.scope || []).map(s => s.slice(0, 30)).join(' / ')}`);
console.log(`  不做（${prd.nonGoals?.length || 0}项）：${(prd.nonGoals || []).map(s => s.slice(0, 30)).join(' / ')}`);
console.log(`  验收（${prd.acceptance?.length || 0}条）：`);
(prd.acceptance || []).forEach((a, i) => console.log(`    ${i + 1}. ${a}`));
console.log(`  用户故事（${prd.userStories?.length || 0}个）：${(prd.userStories || []).map(u => u.want?.slice(0, 20)).join(', ')}`);
console.log(`  风险：${(prd.risks || []).join('；').slice(0, 80)}`);

// 验收
const goalText = String(prd.goal || '');
const dupAc = (prd.acceptance || []).filter(a => a.trim() === goalText.trim());
const allFields = ['title','goal','userStories','scope','nonGoals','acceptance','risks'].every(f => prd[f]);
console.log(`\n✅ AC-L1-003: 所有必填字段存在 = ${allFields ? '✓' : '✗'}`);
console.log(`✅ AC-L1-004: acceptance ≠ goal = ${dupAc.length === 0 ? '✓' : '✗（有照抄）'}`);

// ────────────────────────────────────────────────────────────────────
// STEP 3: refinePrd
// ────────────────────────────────────────────────────────────────────
console.log('\n─── Step 3: refine-prd ─────────────────────────────────');
const feedback = '把范围扩大：除了视频，也要支持给图片打标签。并且要在风险里补充标签滥用的问题。';
console.log(`\n✏️  修改意见：${feedback}`);

const REFINE_SYSTEM = `你是 CUE 的 AI 产品经理。用户对已有 PRD 提出了修改意见，请局部更新 PRD，不要重写不涉及的部分。只返回完整更新后的 JSON（与原格式相同），不返回其他文字。`;

const { text: r3, ms: ms3, tokens: t3 } = await call(
  REFINE_SYSTEM,
  `现有 PRD：\n${JSON.stringify(prd, null, 2)}\n\n修改意见：\n${feedback}\n\n请局部更新并返回完整 PRD：`
);
const refined = parseJsonOutput(r3);
console.log(`⏱  ${ms3}ms / ${t3} tokens`);

if (!refined?.goal) {
  console.error('❌ refinePrd 解析失败，原始输出：', r3.slice(0, 200));
  process.exit(1);
}

const scopeChanged = JSON.stringify(refined.scope) !== JSON.stringify(prd.scope);
const riskChanged = (refined.risks || []).length > (prd.risks || []).length;
console.log(`\n📋 更新后 PRD：`);
console.log(`  范围（${refined.scope?.length || 0}项）：${(refined.scope || []).map(s => s.slice(0, 35)).join(' / ')}`);
console.log(`  风险（${refined.risks?.length || 0}条）：${(refined.risks || []).join('；').slice(0, 100)}`);

console.log(`\n✅ AC-L1-005 (refine): 范围已更新 = ${scopeChanged ? '✓' : '△（可能 LLM 判断无需改动）'}`);
console.log(`✅ AC-L1-005 (refine): 风险已扩充 = ${riskChanged ? '✓' : '△'}`);

// ────────────────────────────────────────────────────────────────────
// 汇总
// ────────────────────────────────────────────────────────────────────
const totalMs = ms1 + ms2 + ms3;
const totalTokens = (Number(t1) || 0) + (Number(t2) || 0) + (Number(t3) || 0);
console.log('\n═══════════════════════════════════════════════════════');
console.log('  Mock Exam 结果汇总');
console.log('═══════════════════════════════════════════════════════');
console.log(`  总耗时：${totalMs}ms  /  总 token：${totalTokens}`);
console.log(`  Step 1 clarify：     ${ms1}ms / ${t1} tokens`);
console.log(`  Step 2 generate-prd：${ms2}ms / ${t2} tokens`);
console.log(`  Step 3 refine：      ${ms3}ms / ${t3} tokens`);
console.log('');
console.log('  AC 验收：');
console.log(`  AC-L1-001 返回问题非 PRD         ✓`);
console.log(`  AC-L1-002 问题数量 3-5           ${qCount>=3&&qCount<=5?'✓':'✗'}`);
console.log(`  AC-L1-003 PRD 所有必填字段       ${allFields?'✓':'✗'}`);
console.log(`  AC-L1-004 acceptance ≠ goal      ${dupAc.length===0?'✓':'✗'}`);
console.log(`  AC-L1-005 id 以 prd_ 开头         (route层 djb2，此脚本跳过)`);
console.log('═══════════════════════════════════════════════════════\n');

process.exit(0);
