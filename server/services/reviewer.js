import { callClaude, parseJsonOutput, isAvailable } from './claude.js';
import logger from '../logger.js';


const MAX_DIFF_LEN = 4000;
const VALID_LEVELS = ['Pass', 'Warning', 'Block', 'Escalate'];

const riskyPatterns = [
  { pattern: /password|secret|token|private_key/i, penalty: 16, finding: '涉及凭据、token 或密钥相关代码，需要人工复查安全边界。' },
  { pattern: /delete\s+from|drop\s+table|truncate/i, penalty: 20, finding: '包含高风险数据库操作，需要确认迁移和回滚方案。' },
  { pattern: /todo|fixme|hack/i, penalty: 6, finding: '存在 TODO/FIXME/HACK 标记，建议补齐处理方案。' },
  { pattern: /console\.log|debugger/i, penalty: 4, finding: '包含调试语句，合并前应清理或确认用途。' },
  { pattern: /auth|payment|billing|permission/i, penalty: 10, finding: '涉及认证、支付或权限模块，应提高审阅等级。' }
];

/** 将 LLM 输出的 level 规范化为枚举值 */
function normalizeLevel(raw, score) {
  if (raw) {
    const exact = VALID_LEVELS.find((l) => l === raw);
    if (exact) return exact;
    const s = String(raw).toLowerCase().trim();
    if (s === 'pass' || s === '通过') return 'Pass';
    if (s === 'warning' || s === 'warn' || s === '提醒' || s === '警告') return 'Warning';
    if (s === 'block' || s === 'blocked' || s === '阻断' || s === '阻止') return 'Block';
    if (s === 'escalate' || s === 'escalated' || s === '升级') return 'Escalate';
  }
  if (score >= 80) return 'Pass';
  if (score >= 60) return 'Warning';
  if (score >= 40) return 'Block';
  return 'Escalate';
}

/**
 * 从 issues 和 compliance 派生审阅等级（不再让 LLM 直接判）。
 * 规则：
 *  - 任何 critical issue → Block
 *  - 任何 security/payment 高影响 issue → Escalate
 *  - compliance.notDone 非空且应该被这次提交满足 → Warning
 *  - 其他 → Pass
 */
function deriveLevel(issues = [], compliance = null) {
  const hasCritical = issues.some((i) => i.severity === 'critical');
  const hasSecurity = issues.some((i) => i.severity === 'critical' && /auth|payment|secret|token|password|permission/i.test((i.header || '') + (i.description || '')));
  if (hasSecurity) return 'Escalate';
  if (hasCritical) return 'Block';
  if (issues.some((i) => i.severity === 'major')) return 'Warning';
  if (compliance && (compliance.notDone || []).length > 0 && (compliance.done || []).length === 0) return 'Warning';
  return 'Pass';
}

/** 从 issues 数量和 severity 估算评分 */
function deriveScore(issues = []) {
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === 'critical') score -= 20;
    else if (issue.severity === 'major') score -= 10;
    else if (issue.severity === 'minor') score -= 4;
  }
  return Math.max(0, Math.min(100, score));
}

const REVIEWER_SYSTEM_PROMPT = `你是 CUE Project Hub 的代码审阅 AI，参考 PR-Agent 设计。对提交的代码变更做两件事：

(一) 验收标准对账（仅当用户输入提供了 "任务验收标准" 时执行；未提供则全部留空数组）
  必须先把验收标准用自己的话逐条列出（写入 ticket_requirements），然后把每条归入：
  - done：本次或既往提交已经实现，且这次没有破坏
  - notDone：尚未实现，或这次提交把之前实现的功能改坏了
  - needsHumanCheck：仅从代码无法判定（UI 视觉、运行时行为、外部服务联动等）

  规则：
  - 必须涵盖每一条验收标准（done + notDone + needsHumanCheck 加起来等于全部）
  - 不要新增没出现在验收标准里的条目
  - 即使本次 commit 没碰相关代码，也要基于"项目当前整体状态"给判断（不只看 diff）

(二) 代码问题检测
  按 PR-Agent 的"非对称报告"原则：
  - 明显 bug、安全问题：必须报，宁可严格也不漏
  - 低影响、低确信：宁可不报也不要猜
  - 高影响但不确定：报，并在 description 里标注不确定点
  每个问题必须给具体 file、startLine、endLine 和触发场景，禁止"建议关注代码质量"这种空话。

输出严格遵守如下 JSON 格式，不要任何多余文字：

{
  "ticket_requirements": ["验收标准1原文复述", "验收标准2原文复述"],
  "compliance": {
    "done": ["..."],
    "notDone": ["..."],
    "needsHumanCheck": ["..."]
  },
  "issues": [
    {
      "file": "src/path/to/file.js",
      "startLine": 42,
      "endLine": 47,
      "severity": "critical|major|minor",
      "header": "Possible Bug",
      "description": "具体的问题、触发场景、不确定点"
    }
  ],
  "suggestion": "总体建议，50 字以内"
}`;

/**
 * AC-only 模式：PR-Agent 已负责代码质量审阅时，Hub 只做 Task AC 对账
 * issues 留空数组，节省 token，避免重复分析
 */
const REVIEWER_AC_ONLY_PROMPT = `你是 CUE Project Hub 的验收标准核查 AI。
本次代码质量审阅由 PR-Agent 负责，你只需要完成一件事：

验收标准对账（仅当用户输入提供了"任务验收标准"时执行；未提供则所有数组留空）
  - done：本次或既往提交已实现，且这次没有破坏
  - notDone：尚未实现，或这次把之前实现的功能改坏了
  - needsHumanCheck：仅从代码无法判定（UI 视觉、运行时行为、外部服务等）

规则：
  - 必须涵盖每一条验收标准，三桶加起来等于全部条目
  - 不要新增验收标准里没有的条目
  - 不需要检测代码问题（issues 返回空数组）

输出严格遵守如下 JSON 格式，不要任何多余文字：

{
  "ticket_requirements": ["验收标准1原文复述"],
  "compliance": {
    "done": ["..."],
    "notDone": ["..."],
    "needsHumanCheck": ["..."]
  },
  "issues": [],
  "suggestion": ""
}`;

function countChangedLines(diff) {
  const lines = String(diff || '').split('\n');
  return lines.filter((line) => line.startsWith('+') || line.startsWith('-')).length;
}

function reviewChangeWithRules({ title = '', repo = '', owner = '', diff = '', files = [] }) {
  const text = `${title}\n${diff}\n${files.join('\n')}`;
  const findings = [];
  const issues = [];
  let score = 100;

  for (const rule of riskyPatterns) {
    if (rule.pattern.test(text)) {
      score -= rule.penalty;
      findings.push(rule.finding);
      issues.push({
        file: files[0] || 'unknown',
        startLine: 0,
        endLine: 0,
        severity: rule.penalty >= 16 ? 'critical' : rule.penalty >= 10 ? 'major' : 'minor',
        header: rule.finding.slice(0, 20),
        description: rule.finding
      });
    }
  }

  const changedLines = countChangedLines(diff);
  if (changedLines > 500) {
    score -= 12;
    findings.push('单次变更超过 500 行，建议拆分 PR 降低审阅风险。');
  } else if (changedLines > 180) {
    score -= 6;
    findings.push('单次变更偏大，建议确认是否可以拆分。');
  }

  score = Math.max(0, Math.min(100, score));
  const level = deriveLevel(issues, null);

  return {
    repo, title, owner,
    score,
    level,
    findings: findings.length ? findings : ['未发现明显阻断问题，可进入人工审阅。'],
    suggestion: '',
    compliance: null,
    issues,
    _source: 'rule-engine',
    createdAt: new Date().toISOString()
  };
}

/**
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.repo
 * @param {string} params.owner
 * @param {string} params.diff
 * @param {string[]} params.files
 * @param {object} [params.task]  关联任务（含 id/title/acceptance），用于验收对账
 */
/**
 * @param {object} params
 * @param {string}  params.title
 * @param {string}  params.repo
 * @param {string}  params.owner
 * @param {string}  params.diff
 * @param {string[]} params.files
 * @param {object}  [params.task]          关联任务（含 acceptance），用于验收对账
 * @param {Array}   [params.prAgentIssues] PR-Agent 已提供的代码问题（传入时走 AC-only 模式）
 */
export async function reviewChange({ title = '', repo = '', owner = '', diff = '', files = [], task = null, prAgentIssues = null }) {
  // 如果 PR-Agent 已提供代码问题，Hub 只做 AC 对账，不重复做代码质量分析
  const acOnlyMode = Array.isArray(prAgentIssues) && prAgentIssues.length > 0;

  if (isAvailable()) {
    const truncatedDiff = diff.length > MAX_DIFF_LEN
      ? diff.slice(0, MAX_DIFF_LEN / 2) + '\n\n... [diff 已截断] ...\n\n' + diff.slice(-MAX_DIFF_LEN / 2)
      : diff;

    const acceptanceBlock = task?.acceptance?.trim()
      ? `关联任务：${task.title}\n任务验收标准（原文）：\n${task.acceptance}\n`
      : '（本次提交未关联任务，留空 compliance 即可）\n';

    const userPrompt = `仓库：${repo}
提交标题：${title}
作者：${owner}
变更文件：${files.slice(0, 10).join(', ') || '（未提供）'}
${acceptanceBlock}
Diff 内容：
${truncatedDiff}`.trim();

    const systemPrompt = acOnlyMode ? REVIEWER_AC_ONLY_PROMPT : REVIEWER_SYSTEM_PROMPT;
    const raw = await callClaude(systemPrompt, userPrompt);
    const result = parseJsonOutput(raw);

    if (result && (result.compliance || result.issues)) {
      const compliance = task?.acceptance?.trim()
        ? {
            taskId: task.id,
            taskTitle: task.title,
            requirements: Array.isArray(result.ticket_requirements) ? result.ticket_requirements : [],
            done: Array.isArray(result.compliance?.done) ? result.compliance.done : [],
            notDone: Array.isArray(result.compliance?.notDone) ? result.compliance.notDone : [],
            needsHumanCheck: Array.isArray(result.compliance?.needsHumanCheck) ? result.compliance.needsHumanCheck : []
          }
        : null;

      // AC-only 模式：用 PR-Agent 的 issues；全量模式：用 Hub LLM 的 issues
      const issues = acOnlyMode
        ? prAgentIssues
        : (Array.isArray(result.issues) ? result.issues.filter((i) => i && i.file) : []);

      const score = deriveScore(issues);
      const level = deriveLevel(issues, compliance);
      const findings = issues.length
        ? issues.map((i) => `${i.header || ''}: ${i.description || ''}`.trim())
        : ['未发现明显问题。'];

      return {
        repo, title, owner,
        score,
        level,
        findings,
        suggestion: String(result.suggestion || ''),
        compliance,
        issues,
        _source: acOnlyMode ? 'llm+pr-agent' : 'llm',
        createdAt: new Date().toISOString()
      };
    }
    logger.warn('[Reviewer] LLM 输出解析失败或缺少必填字段，降级到规则引擎');
  }
  return reviewChangeWithRules({ title, repo, owner, diff, files });
}
