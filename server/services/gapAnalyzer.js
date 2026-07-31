/**
 * gapAnalyzer.js
 * L4-c: PR 业务缺口分析 —— acceptance criteria ↔ PR diff 一次性比对（SPEC-L4c）
 *
 * 接线点：
 *   主路 — webhookRoutes.js（PR merged 块，与 E1 refreshAnalysis 并排，fire-and-forget）
 *   次路 — routes/gapAnalyses.js（POST /v2/gap-analyses/run 手动补跑）
 *
 * 设计：只比对 acceptance 文本 ↔ diff 文本，不读代码、不跑 ReAct（读代码级缺口归 T14）。
 * LLM 不可用 / 解析失败时降级 riskLevel='unknown'，绝不抛错阻塞 webhook。
 */

import logger from '../logger.js';
import { fetchPRDiff, parseRepo } from './githubApi.js';
import { callClaude, parseJsonOutput } from './claude.js';

// diff 截断上限，控制 token 成本（SPEC-L4c 技术方案）
const DIFF_MAX_CHARS = 8000;

// 静态 system prompt —— 不含 acceptance/diff 等会变内容，保持 prompt cache 友好
const GAP_SYSTEM_PROMPT = `你是软件交付的验收对账分析师。给定一个任务的「验收标准（acceptance criteria）」和该任务对应 PR 的「代码改动 diff」，判断 PR 是否真正覆盖了验收标准。

只依据 diff 文本与验收标准文本做判断，不要臆测 diff 之外的实现。

严格输出 JSON（不要任何额外说明文字），结构如下：
{
  "covered":   ["已被 diff 覆盖的验收点，逐条", "..."],
  "missing":   ["验收标准要求但 diff 中看不到对应实现的点，逐条", "..."],
  "riskLevel": "low | medium | high",
  "reasoning": "一句话总体判断，说明为什么是这个风险等级"
}

riskLevel 规则：missing 为空 → low；有少量非核心 missing → medium；核心验收点缺失 → high。`;

export function buildUserPrompt(acceptance, diff) {
  return `## 任务验收标准（acceptance criteria）
${acceptance}

## PR 代码改动 diff（已截断至 ${DIFF_MAX_CHARS} 字符）
\`\`\`diff
${diff}
\`\`\`

请按系统约定的 JSON 结构输出比对结果。`;
}

/**
 * 从 pull 条目解析 owner/repo。
 * pull.repo 形如 "owner/repo"；拿不到时回退用 projectId 查 project 再 parseRepo。
 */
function resolveOwnerRepo(pull, store) {
  const full = String(pull.repo || '');
  if (full.includes('/')) {
    const [owner, repo] = full.split('/');
    if (owner && repo) return { owner, repo };
  }
  const project = (store.projects || []).find((p) => p.id === pull.projectId);
  if (project) {
    try {
      const { owner, repo } = parseRepo(project);
      if (owner && repo) return { owner, repo };
    } catch { /* 解析失败走下方 null */ }
  }
  return { owner: null, repo: null };
}

/**
 * 对单个 pull 执行业务缺口分析并写入 store.gapAnalyses[pull.id]。
 *
 * @param {object}   pull        - store.pulls 条目（需含 id / number / repo / taskId|linkedTaskIds）
 * @param {object}   store       - 已加载的 store 快照（读 tasks / projects）
 * @param {Function} updateStore - store 原子更新函数（已绑定 tenant，调用方负责传对租户的）
 * @param {string}   [tenantId]  - 写 updateStore 时的租户（默认 'default'）
 * @param {object}   [deps]      - 可注入依赖（测试用）：{ fetchPRDiff, callClaude }
 * @returns {Promise<{ skipped?: boolean, reason?: string, analysis?: object }>}
 */
export async function analyzeGap(pull, store, updateStore, tenantId = 'default', deps = {}) {
  const _fetchPRDiff = deps.fetchPRDiff || fetchPRDiff;
  const _callClaude  = deps.callClaude  || callClaude;
  if (!pull || !pull.id) return { skipped: true, reason: 'no-pull' };

  const taskId = pull.taskId || pull.linkedTaskIds?.[0] || null;
  if (!taskId) return { skipped: true, reason: 'no-task' };

  const task = (store.tasks || []).find((t) => t.id === taskId);
  const acceptance = String(task?.acceptance || '').trim();
  if (!acceptance) return { skipped: true, reason: 'no-acceptance' };

  const prNumber = pull.prNumber || pull.number;
  const { owner, repo } = resolveOwnerRepo(pull, store);
  if (!owner || !repo || !prNumber) return { skipped: true, reason: 'no-pr-coords' };

  // 取 diff（截断控制 token）；拉取失败不阻断，降级为空 diff 让 LLM 判 unknown
  let diff = '';
  try {
    diff = (await _fetchPRDiff(owner, repo, prNumber) || '').slice(0, DIFF_MAX_CHARS);
  } catch (err) {
    logger.warn(`[L4c] fetchPRDiff 失败 ${owner}/${repo}#${prNumber}: ${err.message}`);
  }

  const raw = await _callClaude(GAP_SYSTEM_PROMPT, buildUserPrompt(acceptance, diff));
  const parsed = raw ? parseJsonOutput(raw) : null;

  const result = parsed && typeof parsed === 'object'
    ? {
        covered:   Array.isArray(parsed.covered) ? parsed.covered : [],
        missing:   Array.isArray(parsed.missing) ? parsed.missing : [],
        riskLevel: ['low', 'medium', 'high'].includes(parsed.riskLevel) ? parsed.riskLevel : 'unknown',
        reasoning: String(parsed.reasoning || '').slice(0, 500),
        source:    'llm',
      }
    : {
        covered:   [],
        missing:   [],
        riskLevel: 'unknown',
        reasoning: 'LLM 不可用或返回无法解析，已降级（SPEC-L4c REQ-005）',
        source:    'fallback',
      };

  const analysis = {
    pullId:     pull.id,
    taskId,
    prNumber,
    tenantId,
    acceptance,
    ...result,
    analyzedAt: new Date().toISOString(),
  };

  await updateStore((draft) => {
    if (!draft.gapAnalyses || typeof draft.gapAnalyses !== 'object') draft.gapAnalyses = {};
    draft.gapAnalyses[pull.id] = analysis;
    return draft;
  }, tenantId);

  logger.info(`[L4c] gap 分析完成 pull=${pull.id} task=${taskId} risk=${analysis.riskLevel} missing=${analysis.missing.length}`);
  return { analysis };
}

/**
 * webhook 主路入口：PR merged 后按 repoFull + prNumber 在 store 中定位 pull，再做缺口分析。
 *
 * @param {{ repoFull: string, prNumber: number }} ev
 * @param {Function} loadStore   - 加载 store 快照
 * @param {Function} updateStore - store 原子更新
 * @param {string}   [tenantId]  - 默认 'default'
 */
export async function analyzeGapForMergedPR({ repoFull, prNumber }, loadStore, updateStore, tenantId = 'default') {
  const store = await loadStore(tenantId);
  const repoLc = String(repoFull || '').toLowerCase();

  const pull = (store.pulls || []).find((p) => {
    const numMatch = (p.prNumber || p.number) === prNumber;
    if (!numMatch) return false;
    // repo 能匹配则优先匹配，匹配不上（pull.repo 不规范）也接受 number 命中
    if (!repoLc) return true;
    return String(p.repo || '').toLowerCase() === repoLc || !p.repo;
  });

  if (!pull) {
    logger.info(`[L4c] PR merged 未找到对应 pull：${repoFull}#${prNumber}，跳过缺口分析`);
    return { skipped: true, reason: 'pull-not-found' };
  }
  return analyzeGap(pull, store, updateStore, tenantId);
}
