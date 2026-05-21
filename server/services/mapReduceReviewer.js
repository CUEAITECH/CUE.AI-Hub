// server/services/mapReduceReviewer.js
// W6-T2: Map-Reduce 代码审阅器
//
// Map：对每个 FileDiff 并发调用 LLM review（最多 CONCURRENCY 个同时）
// Reduce：聚合所有文件的 issues，派生最终 level，写入 reviews 表
//
// 设计原则：
//   - Map 层只看单个文件，不跨文件推断
//   - Reduce 层负责全局判断（level、compliance、建议文字）
//   - LLM 不可用时，每个文件走规则引擎 fallback（risky patterns）
//   - 并发上限 CONCURRENCY=4，避免 rate limit

import PQueue from 'p-queue';
import { callClaude, parseJsonOutput } from './claude.js';
import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';

const CONCURRENCY = 4;

// ── 规则引擎（LLM fallback）────────────────────────────────────
const RISKY_PATTERNS = [
  { re: /password|secret|api[_-]?key|private[_-]?key/i, severity: 'critical', header: '涉及凭据或密钥', desc: '代码包含凭据、token 或密钥相关内容，需人工审查安全边界。' },
  { re: /delete\s+from|drop\s+table|truncate\s+table/i, severity: 'critical', header: '高风险数据库操作', desc: '包含 DELETE/DROP/TRUNCATE，需确认迁移和回滚方案。' },
  { re: /eval\s*\(|new\s+Function\s*\(/i, severity: 'critical', header: '动态代码执行', desc: '使用 eval 或 new Function，存在 XSS/RCE 风险。' },
  { re: /innerHTML\s*=/i, severity: 'major', header: 'innerHTML 赋值', desc: '直接赋值 innerHTML 可能导致 XSS，建议改用 textContent 或 DOM API。' },
  { re: /console\.(log|debug|info|warn|error)/i, severity: 'minor', header: '调试语句', desc: '包含 console 调试语句，合并前确认是否保留。' },
  { re: /TODO|FIXME|HACK|XXX/i, severity: 'minor', header: 'TODO/FIXME 标记', desc: '存在未完成标记，建议在合并前处理或记录 issue。' },
  { re: /auth|payment|billing|permission/i, severity: 'major', header: '涉及认证/支付模块', desc: '涉及认证、支付或权限，应提高审阅优先级。' },
];

function ruleReviewFile(fileDiff) {
  const issues = [];
  const text = fileDiff.diffText;
  const addedLines = text.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));

  for (const { re, severity, header, desc } of RISKY_PATTERNS) {
    if (addedLines.some(l => re.test(l))) {
      issues.push({
        file: fileDiff.path,
        severity,
        header,
        description: desc,
        startLine: null,
        endLine: null,
      });
    }
  }
  return issues;
}

// ── Map：单文件 LLM review ────────────────────────────────────

const MAP_SYSTEM_PROMPT = `你是代码审阅专家。对单个文件的 diff 做精确审阅。

只返回 JSON 数组（不需要其他文字），每个 issue 格式：
{
  "severity": "critical|major|minor",
  "header": "一句话标题（15字内）",
  "description": "具体问题描述 + 建议修改方向（50字内）",
  "startLine": null 或行号,
  "endLine": null 或行号
}

规则：
- critical：安全漏洞、数据损坏风险、破坏性变更
- major：逻辑错误、性能问题、违反团队约定
- minor：代码风格、调试语句、命名不规范
- 只审阅新增行（以 + 开头），忽略删除行
- 没有问题时返回空数组 []
- 不要超过 5 个 issue`;

async function mapFile(fileDiff, memory = []) {
  const memCtx = memory.length > 0
    ? `\n团队约定（参考）：\n${memory.map(m => `[${m.kind}] ${m.body}`).join('\n')}\n`
    : '';

  const userPrompt = `文件：${fileDiff.path}（${fileDiff.changeType}，+${fileDiff.additions}/-${fileDiff.deletions} 行）
${memCtx}
\`\`\`diff
${fileDiff.diffText}
\`\`\``;

  // 单文件 review 最多等 30s，超时降级到规则引擎
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const result = await callClaude(MAP_SYSTEM_PROMPT, userPrompt, { signal: controller.signal });
    clearTimeout(timer);
    if (!result) return ruleReviewFile(fileDiff); // LLM 不可用 → 规则

    const parsed = parseJsonOutput(result);
    if (!Array.isArray(parsed)) return ruleReviewFile(fileDiff);

    return parsed
      .filter(i => i.severity && i.header)
      .slice(0, 5)
      .map(i => ({
        file: fileDiff.path,
        severity: i.severity,
        header: i.header,
        description: i.description || '',
        startLine: i.startLine || null,
        endLine: i.endLine || null,
      }));
  } catch {
    clearTimeout(timer);
    return ruleReviewFile(fileDiff);
  }
}

// ── Reduce：聚合所有文件 issues → report ──────────────────────

const REDUCE_SYSTEM_PROMPT = `你是代码审阅主审。根据各文件的 issue 列表和任务验收标准，给出最终审阅意见。

返回 JSON（不需要其他文字）：
{
  "level": "Pass|Warning|Block|Escalate",
  "summary": "2-3句话总结这次 PR 的整体质量和主要问题",
  "suggestion": "给开发者的最重要改进建议（1条，50字内）",
  "compliance": {
    "done": ["已满足的 AC 条目"],
    "notDone": ["未满足的 AC 条目"],
    "needsHumanCheck": ["需要人工确认的 AC 条目"]
  }
}

level 判断规则：
- Escalate：有 critical 且涉及安全/支付
- Block：有 critical
- Warning：有 major
- Pass：只有 minor 或无 issue`;

async function reduceIssues({ allIssues, acceptance, prTitle, memory = [] }) {
  const memCtx = memory.filter(m => m.kind === 'taboo' || m.kind === 'gotcha').slice(0, 5)
    .map(m => `[${m.kind}] ${m.body}`).join('\n');

  const issuesSummary = allIssues.length === 0
    ? '（无 issue）'
    : allIssues.map(i => `[${i.severity}] ${i.file}: ${i.header} — ${i.description}`).join('\n');

  const acText = acceptance || '（未填写验收标准）';

  const userPrompt = `PR 标题：${prTitle}

验收标准（AC）：
${acText}

各文件 Issues（共 ${allIssues.length} 条）：
${issuesSummary}

${memCtx ? `团队约定（taboo/gotcha）：\n${memCtx}` : ''}`;

  // Reduce 阶段最多等 45s
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  try {
    const result = await callClaude(REDUCE_SYSTEM_PROMPT, userPrompt, { signal: controller.signal });
    clearTimeout(timer);
    if (!result) return ruleReduce(allIssues, acceptance);

    const parsed = parseJsonOutput(result);
    if (!parsed || typeof parsed !== 'object') return ruleReduce(allIssues, acceptance);

    return {
      level: normalizeLevel(parsed.level),
      summary: parsed.summary || '',
      suggestion: parsed.suggestion || '',
      compliance: {
        done: parsed.compliance?.done || [],
        notDone: parsed.compliance?.notDone || [],
        needsHumanCheck: parsed.compliance?.needsHumanCheck || [],
      },
    };
  } catch {
    clearTimeout(timer);
    return ruleReduce(allIssues, acceptance);
  }
}

function ruleReduce(allIssues, acceptance) {
  const hasCritical = allIssues.some(i => i.severity === 'critical');
  const hasSecurity = allIssues.some(i => i.severity === 'critical' &&
    /auth|payment|secret|token|password/i.test(i.header + i.description));
  const hasMajor = allIssues.some(i => i.severity === 'major');

  let level = 'Pass';
  if (hasSecurity) level = 'Escalate';
  else if (hasCritical) level = 'Block';
  else if (hasMajor) level = 'Warning';

  const acItems = (acceptance || '').split('\n').map(l => l.trim()).filter(l => l.length > 0);

  return {
    level,
    summary: `规则引擎审阅：发现 ${allIssues.length} 个 issue（${allIssues.filter(i => i.severity === 'critical').length} critical, ${allIssues.filter(i => i.severity === 'major').length} major）。`,
    suggestion: allIssues[0] ? `优先处理：${allIssues[0].header}` : '代码质量良好',
    compliance: { done: [], notDone: acItems, needsHumanCheck: [] },
  };
}

function normalizeLevel(raw) {
  if (!raw) return 'Pass';
  const s = String(raw).toLowerCase().trim();
  if (s === 'escalate' || s === '升级') return 'Escalate';
  if (s === 'block' || s === 'blocked' || s === '阻断') return 'Block';
  if (s === 'warning' || s === 'warn' || s === '警告') return 'Warning';
  return 'Pass';
}

// ── 主入口 ─────────────────────────────────────────────────────

/**
 * 对一个 PR 跑完整 Map-Reduce review
 *
 * @param {object} params
 * @param {import('./diffAnalyzer.js').FileDiff[]} params.files   - 从 diffAnalyzer 得到的文件列表
 * @param {string}   params.prTitle
 * @param {string}   [params.acceptance]  - 任务 AC 文本
 * @param {object[]} [params.memory]      - project_memory 条目
 * @param {string}   params.tenantId
 * @param {string}   params.pullId        - pulls 表的 id（写 reviews 用）
 * @param {string}   [params.taskId]      - 关联任务 id（可选）
 * @returns {Promise<{
 *   level: string; summary: string; suggestion: string;
 *   issues: object[]; compliance: object;
 *   reviewId: string; stats: object;
 * }>}
 */
export async function mapReduceReview({ files, prTitle, acceptance, memory = [], tenantId, pullId, taskId }) {
  const startTime = Date.now();

  // ── Map 阶段（并发，上限 CONCURRENCY） ──────────────────────
  const queue = new PQueue({ concurrency: CONCURRENCY });
  const mapResults = await Promise.all(
    files.map(fileDiff =>
      queue.add(() => mapFile(fileDiff, memory))
    )
  );

  // 展平所有 issues
  const allIssues = mapResults.flat();

  // ── Reduce 阶段 ──────────────────────────────────────────────
  const reduced = await reduceIssues({ allIssues, acceptance, prTitle, memory });

  // ── 写入 reviews 表 ──────────────────────────────────────────
  const reviewId = `review_mr_${pullId}_${Date.now()}`;
  const now = new Date().toISOString();

  await dbWrite('mapReduceReviewer:write', (db) => {
    db.prepare(`
      INSERT INTO reviews
        (id, tenant_id, pull_id, task_id, source, level,
         compliance_json, findings_json, suggestion, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reviewId,
      tenantId,
      pullId,
      taskId || null,
      'map-reduce',
      reduced.level,
      JSON.stringify(reduced.compliance),
      JSON.stringify(allIssues),
      reduced.suggestion,
      now, now
    );
  });

  const elapsed = Date.now() - startTime;
  console.log(`[mapReduceReviewer] PR ${pullId}: ${files.length} files, ${allIssues.length} issues → ${reduced.level} (${elapsed}ms)`);

  return {
    level:      reduced.level,
    summary:    reduced.summary,
    suggestion: reduced.suggestion,
    issues:     allIssues,
    compliance: reduced.compliance,
    reviewId,
    stats: {
      filesReviewed: files.length,
      issuesFound:   allIssues.length,
      critical:      allIssues.filter(i => i.severity === 'critical').length,
      major:         allIssues.filter(i => i.severity === 'major').length,
      minor:         allIssues.filter(i => i.severity === 'minor').length,
      elapsedMs:     elapsed,
    },
  };
}
