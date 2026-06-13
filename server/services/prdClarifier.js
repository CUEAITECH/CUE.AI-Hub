/**
 * prdClarifier.js — SPEC-L1：想法 → 澄清反问 → 标准 PRD
 *
 * 接口：
 *   clarify(input)                     → { clarificationQuestions[], initialUnderstanding }
 *   generatePrd(input, answers)        → PRD 对象
 *   refinePrd(prd, feedback)           → 更新后的 PRD 对象（局部更新）
 */

import { callClaude, parseJsonOutput, isAvailable } from './claude.js';
import logger from '../logger.js';

// ── djb2 hash —— 与 docsManager/reviewTaskLinker 保持一致 ────────────
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  return `prd_${h.toString(36).padStart(7, '0')}`;
}

// ── 系统提示（稳定内容放 system，不放 user，保护 prompt cache） ────────
const CLARIFY_SYSTEM = `你是 CUE 的 AI 产品经理。用户描述一个想法时，你的第一步是识别模糊之处并提问，而不是直接生成任务。

聚焦四类问题：
1. 目标用户是谁，他们有什么具体痛点？
2. 做完了什么算成功（可量化的指标）？
3. 范围边界：这次做什么，明确不做什么？
4. 已知约束：技术/时间/资源限制？

规则：
- 问题数量 3-5 个，不超过 5 个
- 每个问题聚焦一个维度，不合并
- 如果输入已经足够清晰，可以只问 2 个确认问题

只返回 JSON，格式：
{
  "clarificationQuestions": ["问题1", "问题2", "问题3"],
  "initialUnderstanding": "我理解你想做的是..."
}`;

const PRD_SYSTEM = `你是 CUE 的 AI 产品经理。根据用户的原始想法和澄清回答，生成一份标准结构化 PRD。

PRD 必须包含所有字段，acceptance 字段必须是可测量的完成条件，不能照抄 goal。

只返回 JSON，格式：
{
  "title": "PRD 标题（20字内）",
  "goal": "一句话：这个功能为谁解决什么问题",
  "userStories": [
    { "id": "US-001", "as": "角色", "want": "操作", "so": "收益", "acceptance": "可测量的完成条件" }
  ],
  "scope": ["在范围内的内容1", "..."],
  "nonGoals": ["明确不做的内容1", "..."],
  "acceptance": ["整体验收标准1（可量化）", "..."],
  "risks": ["已知风险1", "..."]
}`;

const REFINE_SYSTEM = `你是 CUE 的 AI 产品经理。用户对已有 PRD 提出了修改意见，请局部更新 PRD，不要重写不涉及的部分。

只返回完整更新后的 JSON（与原格式相同），不返回其他文字。`;

// ── 规则引擎降级 ─────────────────────────────────────────────────────
function fallbackClarify(input) {
  const questions = [
    `这个功能的主要目标用户是谁，他们现在面临什么具体问题？`,
    `功能上线后，怎样算做成功了？有没有可量化的指标？`,
    `这次明确不做哪些事情（范围边界）？`,
  ];
  return {
    clarificationQuestions: questions,
    initialUnderstanding: `我理解你想做的是：${String(input || '').slice(0, 60)}...（请回答以上问题帮助我更准确理解）`,
  };
}

function fallbackPrd(input, answers, prdId) {
  const now = new Date().toISOString();
  return {
    id: prdId,
    title: String(input || '').slice(0, 30) || '待命名需求',
    version: '1.0',
    createdAt: now,
    updatedAt: now,
    goal: String(input || '').slice(0, 100),
    userStories: [{ id: 'US-001', as: '用户', want: '使用该功能', so: '解决问题', acceptance: '功能正常工作' }],
    scope: ['待补充'],
    nonGoals: ['待补充'],
    acceptance: ['待补充'],
    risks: [],
    sourceInput: input,
    clarificationAnswers: answers,
    status: 'draft',
  };
}

// ── 主接口 ──────────────────────────────────────────────────────────

/**
 * 第一步：对模糊想法生成澄清问题。
 * @param {string} input - 用户的原始想法/需求描述
 * @returns {{ clarificationQuestions: string[], initialUnderstanding: string }}
 */
export async function clarify(input) {
  if (!isAvailable()) return fallbackClarify(input);

  const userPrompt = `用户输入：\n${String(input || '').slice(0, 2000)}`;
  const raw = await callClaude(CLARIFY_SYSTEM, userPrompt, { purpose: 'l1-clarify' });
  if (!raw) return fallbackClarify(input);

  const parsed = parseJsonOutput(raw);
  if (
    !parsed ||
    !Array.isArray(parsed.clarificationQuestions) ||
    !parsed.clarificationQuestions.length
  ) {
    logger.warn('[L1] clarify LLM 输出解析失败，降级');
    return fallbackClarify(input);
  }

  return {
    clarificationQuestions: parsed.clarificationQuestions.slice(0, 5),
    initialUnderstanding: String(parsed.initialUnderstanding || '').slice(0, 200),
  };
}

/**
 * 第二步：根据原始输入 + 澄清回答生成结构化 PRD。
 * @param {string} input
 * @param {Object} answers - { [question]: answer } 或 string（自由文本）
 * @returns {Object} PRD
 */
export async function generatePrd(input, answers) {
  const prdId = djb2(`${input}|${Date.now()}`);
  const now = new Date().toISOString();

  if (!isAvailable()) return fallbackPrd(input, answers, prdId);

  const answersText = typeof answers === 'string'
    ? answers
    : Object.entries(answers || {})
        .map(([q, a]) => `问：${q}\n答：${a}`)
        .join('\n\n');

  const userPrompt = `原始输入：\n${String(input || '').slice(0, 1000)}\n\n澄清回答：\n${answersText.slice(0, 2000)}\n\n请生成完整 PRD：`;
  const raw = await callClaude(PRD_SYSTEM, userPrompt, { purpose: 'l1-generate-prd', maxTokens: 4096 });
  if (!raw) return fallbackPrd(input, answers, prdId);

  const parsed = parseJsonOutput(raw);
  if (!parsed || !parsed.goal || !Array.isArray(parsed.acceptance)) {
    logger.warn('[L1] generatePrd LLM 输出解析失败，降级');
    return fallbackPrd(input, answers, prdId);
  }

  // acceptance 不能照抄 goal（SPEC-L1 AC-L1-004）
  const acceptance = (parsed.acceptance || []).filter(
    (a) => String(a).trim() !== String(parsed.goal || '').trim()
  );

  return {
    id: prdId,
    title: String(parsed.title || input).slice(0, 60),
    version: '1.0',
    createdAt: now,
    updatedAt: now,
    goal: String(parsed.goal || '').slice(0, 200),
    userStories: Array.isArray(parsed.userStories) ? parsed.userStories : [],
    scope: Array.isArray(parsed.scope) ? parsed.scope : [],
    nonGoals: Array.isArray(parsed.nonGoals) ? parsed.nonGoals : [],
    acceptance: acceptance.length ? acceptance : ['待补充'],
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    sourceInput: input,
    clarificationAnswers: answers,
    status: 'draft',
  };
}

/**
 * 第三步：局部更新 PRD（用户提出修改意见）。
 * @param {Object} prd - 现有 PRD 对象
 * @param {string} feedback - 修改意见
 * @returns {Object} 更新后的 PRD
 */
export async function refinePrd(prd, feedback) {
  if (!isAvailable()) return { ...prd, updatedAt: new Date().toISOString() };

  const userPrompt = `现有 PRD：\n${JSON.stringify(prd, null, 2)}\n\n修改意见：\n${String(feedback || '').slice(0, 1000)}\n\n请局部更新并返回完整 PRD：`;
  const raw = await callClaude(REFINE_SYSTEM, userPrompt, { purpose: 'l1-refine-prd', maxTokens: 4096 });
  if (!raw) return { ...prd, updatedAt: new Date().toISOString() };

  const parsed = parseJsonOutput(raw);
  if (!parsed || !parsed.goal) return { ...prd, updatedAt: new Date().toISOString() };

  return {
    ...prd,
    ...parsed,
    id: prd.id,           // ID 不变
    createdAt: prd.createdAt,
    updatedAt: new Date().toISOString(),
    version: String(Number(String(prd.version || '1.0').split('.')[0]) + 0) + '.0',
    status: prd.status || 'draft',
  };
}
