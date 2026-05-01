const riskyPatterns = [
  { pattern: /password|secret|token|private_key/i, penalty: 16, finding: '涉及凭据、token 或密钥相关代码，需要人工复查安全边界。' },
  { pattern: /delete\s+from|drop\s+table|truncate/i, penalty: 20, finding: '包含高风险数据库操作，需要确认迁移和回滚方案。' },
  { pattern: /todo|fixme|hack/i, penalty: 6, finding: '存在 TODO/FIXME/HACK 标记，建议补齐处理方案。' },
  { pattern: /console\.log|debugger/i, penalty: 4, finding: '包含调试语句，合并前应清理或确认用途。' },
  { pattern: /auth|payment|billing|permission/i, penalty: 10, finding: '涉及认证、支付或权限模块，应提高审阅等级。' }
];

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

export function reviewChange({ title = 'Untitled change', repo = 'unknown', owner = '未分配', diff = '', files = [] }) {
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
    createdAt: new Date().toISOString()
  };
}
