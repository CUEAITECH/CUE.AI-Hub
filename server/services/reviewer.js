import { callClaude, parseJsonOutput, isAvailable } from './claude.js';

const riskyPatterns = [
  { pattern: /password|secret|token|private_key/i, penalty: 16, finding: '涉及凭据、token 或密钥相关代码，需要人工复查安全边界。' },
  { pattern: /delete\s+from|drop\s+table|truncate/i, penalty: 20, finding: '包含高风险数据库操作，需要确认迁移和回滚方案。' },
  { pattern: /todo|fixme|hack/i, penalty: 6, finding: '存在 TODO/FIXME/HACK 标记，建议补齐处理方案。' },
  { pattern: /console\.log|debugger/i, penalty: 4, finding: '包含调试语句，合并前应清理或确认用途。' },
  { pattern: /auth|payment|billing|permission/i, penalty: 10, finding: '涉及认证、支付或权限模块，应提高审阅等级。' }
];

const MAX_DIFF_LEN = 4000;

const VALID_LEVELS = ['Pass', 'Warning', 'Block', 'Escalate'];

/** 将 LLM 输出的 level（可能是中文/小写/带空格）规范化为枚举值，无法识别时从 score 推断 */
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
  // 无法识别时从 score 推断，与规则引擎保持一致
  if (score >= 80) return 'Pass';
  if (score >= 60) return 'Warning';
  if (score >= 40) return 'Block';
  return 'Escalate';
}

const REVIEWER_SYSTEM_PROMPT = `你是 CUE Project Hub 的代码审阅 AI。对提交的代码变更进行安全、质量和风险评估。

评分标准（满分 100 分，按扣分规则计算）：
- 包含密钥/Token/Password 相关硬编码：-16 分
- 包含高风险数据库操作（DROP/DELETE/TRUNCATE）：-20 分
- 涉及认证、支付、权限模块：-10 分
- 存在 TODO/FIXME/HACK 标记：-6 分
- 包含 console.log/debugger 调试语句：-4 分
- 单次变更超过 500 行：-12 分
- 单次变更 180-500 行：-6 分
- 无测试文件且超过 40 行变更：-8 分
- 无任务或 ticket 关联：-6 分

等级划分：
- Pass（通过）：80 分以上且无阻断性问题
- Warning（提醒）：60-79 分或有轻微问题
- Block（阻断）：包含密钥泄露、高风险 DB 操作，或低于 60 分
- Escalate（升级）：涉及支付模块或严重安全漏洞

输出要求：仅输出 JSON 对象，不包含任何其他文字。格式如下：
{
  "score": 数字（0-100）,
  "level": "Pass|Warning|Block|Escalate",
  "findings": ["问题描述1", "问题描述2"],
  "suggestion": "综合建议，包括具体改进方向，100字以内"
}`;

function countChangedLines(diff) {
  const lines = String(diff || '').split('\n');
  return lines.filter((line) => line.startsWith('+') || line.startsWith('-')).length;
}

function inferLevel(score, findings) {
  if (score < 70 || findings.some((finding) => finding.includes('高风险数据库') || finding.includes('密钥'))) {
    return 'Block';
  }
  if (score < 86 || findings.length > 0) return 'Warning';
  return 'Pass';
}

function reviewChangeWithRules({ title = 'Untitled change', repo = 'unknown', owner = '未分配', diff = '', files = [] }) {
  const text = `${title}\n${diff}\n${files.join('\n')}`;
  const findings = [];
  let score = 100;

  for (const rule of riskyPatterns) {
    if (rule.pattern.test(text)) {
      score -= rule.penalty;
      findings.push(rule.finding);
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

  const hasTestSignal = /test|spec|测试|__tests__/i.test(text);
  if (!hasTestSignal && changedLines > 40) {
    score -= 8;
    findings.push('变更超过 40 行但没有明显测试文件或测试说明。');
  }

  if (!/#\d+|task_|任务|ticket/i.test(title)) {
    score -= 6;
    findings.push('提交标题没有明显任务或 ticket 关联。');
  }

  score = Math.max(0, Math.min(100, score));

  return {
    repo,
    title,
    owner,
    score,
    level: inferLevel(score, findings),
    findings: findings.length ? findings : ['未发现明显阻断问题，可进入人工审阅。'],
    suggestion: '',
    createdAt: new Date().toISOString()
  };
}

export async function reviewChange({ title = 'Untitled change', repo = 'unknown', owner = '未分配', diff = '', files = [] }) {
  if (isAvailable()) {
    const truncatedDiff = diff.length > MAX_DIFF_LEN
      ? diff.slice(0, MAX_DIFF_LEN / 2) + '\n\n... [diff 已截断] ...\n\n' + diff.slice(-MAX_DIFF_LEN / 2)
      : diff;

    const userPrompt = `仓库：${repo}
提交标题：${title}
作者：${owner}
变更文件：${files.slice(0, 10).join(', ') || '（未提供）'}

Diff 内容：
${truncatedDiff}`.trim();

    const raw = await callClaude(REVIEWER_SYSTEM_PROMPT, userPrompt);
    const result = parseJsonOutput(raw);

    if (result && typeof result.score === 'number') {
      const clampedScore = Math.max(0, Math.min(100, result.score));
      return {
        repo,
        title,
        owner,
        score: clampedScore,
        level: normalizeLevel(result.level, clampedScore),
        findings: Array.isArray(result.findings) ? result.findings : [],
        suggestion: String(result.suggestion || ''),
        createdAt: new Date().toISOString()
      };
    }
    console.warn('[Reviewer] LLM 输出解析失败，降级到规则引擎');
  }
  return reviewChangeWithRules({ title, repo, owner, diff, files });
}
