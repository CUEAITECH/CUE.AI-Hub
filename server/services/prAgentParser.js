/**
 * prAgentParser.js
 * 从 GitHub PR review comments（fetchPRDetail 结果）解析 PR-Agent 的输出，
 * 提取 TicketCompliance 结构（done / notDone / needsHumanCheck）
 *
 * PR-Agent 机器人的 login 通常是 "github-actions[bot]" 或 "pr-agent[bot]"
 */

const PR_AGENT_BOT_PATTERNS = [/pr-agent/i, /codiumai/i, /github-actions\[bot\]/i];

/**
 * 判断 review 是否来自 PR-Agent bot
 */
function isPrAgentBot(userLogin = '') {
  return PR_AGENT_BOT_PATTERNS.some((pattern) => pattern.test(userLogin));
}

/**
 * 从 Markdown checklist 文本中提取三桶
 * 支持格式：
 *   - [x] done item
 *   - [ ] not done item
 *   - [~] needs human check
 */
function parseChecklistFromMarkdown(text = '') {
  const done = [];
  const notDone = [];
  const needsHumanCheck = [];

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // [x] or [X]
    const doneMatch = trimmed.match(/^[-*]\s+\[x\]\s+(.+)/i);
    if (doneMatch) { done.push(doneMatch[1].trim()); continue; }
    // [~] needs human check
    const humanMatch = trimmed.match(/^[-*]\s+\[~\]\s+(.+)/i);
    if (humanMatch) { needsHumanCheck.push(humanMatch[1].trim()); continue; }
    // [ ] not done
    const notDoneMatch = trimmed.match(/^[-*]\s+\[\s\]\s+(.+)/i);
    if (notDoneMatch) { notDone.push(notDoneMatch[1].trim()); continue; }
  }

  return { done, notDone, needsHumanCheck };
}

/**
 * 尝试从 PR-Agent review body 提取打分（"Score: 85" 格式）
 */
function extractScore(text = '') {
  const match = text.match(/score[:\s]+(\d+)/i);
  return match ? Math.min(100, Math.max(0, Number(match[1]))) : null;
}

/**
 * 提取 PR-Agent 报告的 issues（severity + description）
 * PR-Agent 通常以 "🔴 Critical", "🟡 Major", "🟢 Minor" 格式输出
 */
function extractIssues(text = '') {
  const issues = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/critical|blocker/i.test(trimmed) && trimmed.length < 300) {
      issues.push({ severity: 'critical', file: '', line: null, description: trimmed.slice(0, 200) });
    } else if (/major|warning/i.test(trimmed) && trimmed.length < 300) {
      issues.push({ severity: 'major', file: '', line: null, description: trimmed.slice(0, 200) });
    }
  }
  return issues.slice(0, 10);
}

/**
 * 主入口：解析 fetchPRDetail 结果中的 PR-Agent review，返回 prAgentReview 对象
 *
 * @param {object} prDetail - fetchPRDetail 的返回值
 * @returns {{
 *   score: number|null,
 *   compliance: { done: string[], notDone: string[], needsHumanCheck: string[] } | null,
 *   issues: Array<{ severity, file, line, description }>,
 *   rawUrl: string|null
 * } | null}
 */
export function parsePrAgentReview(prDetail) {
  const { reviews = [], reviewComments = [] } = prDetail;

  // 找到 PR-Agent 的 review（优先找 review body，再找 review comments）
  const agentReview = reviews.find((r) => isPrAgentBot(r.user));
  const agentComments = reviewComments.filter((c) => isPrAgentBot(c.user));

  if (!agentReview && agentComments.length === 0) {
    // PR-Agent 还没有跑完，或者没有配置
    return null;
  }

  const allText = [
    agentReview?.body || '',
    ...agentComments.map((c) => c.body || '')
  ].join('\n\n');

  const { done, notDone, needsHumanCheck } = parseChecklistFromMarkdown(allText);
  const score = extractScore(allText);
  const issues = extractIssues(allText);

  // 如果没有解析出任何 checklist 项，compliance 为 null（PR-Agent 没有输出 AC checklist）
  const compliance = (done.length + notDone.length + needsHumanCheck.length) > 0
    ? { done, notDone, needsHumanCheck }
    : null;

  return {
    score,
    compliance,
    issues,
    rawUrl: agentReview?.htmlUrl || agentComments[0]?.createdAt || null
  };
}
