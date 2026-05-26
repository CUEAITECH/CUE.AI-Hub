/**
 * prAgentParser.js
 * 解析 GitHub PR review comments 中 PR-Agent（或 Codex）的输出，
 * 提取结构化 issues、compliance 核查清单、effort 估算
 *
 * 支持的 bot：
 *   - github-actions[bot]          ← PR-Agent 在 Actions 里跑时默认身份
 *   - pr-agent[bot]                ← 使用 GitHub App 时
 *   - codiumai[bot]
 *   - chatgpt-codex-connector[bot] ← GitHub Codex 内置
 *   - copilot-pull-request-reviewer[bot]
 */

const PR_AGENT_BOT_PATTERNS = [
  /pr-agent/i,
  /codiumai/i,
  /qodo/i,
  /github-actions\[bot\]/i,
  /chatgpt-codex/i,
  /codex-connector/i,
  /copilot.*review/i,
];

function isPrAgentBot(userLogin = '') {
  return PR_AGENT_BOT_PATTERNS.some((p) => p.test(userLogin));
}

// ── 清理 markdown 噪声 ────────────────────────────────────────────
function cleanText(raw = '') {
  return raw
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

// ── 从 markdown 提取 PR-Agent 的 issues ───────────────────────────
//
// PR-Agent 常见输出格式（多版本均支持）：
//   格式 A（列表）: - **[Type]:** description
//   格式 B（表格）: | 🔴 | description |
//   格式 C（内联）: ⚡ **Possible issue:** ...
//   Codex 格式:    ### 💡 Suggestion: ...
function extractIssues(text = '') {
  const issues = [];

  // 锁定 "Possible issues / Key issues" 区段，避免误抓其他内容
  const sectionRe = /(?:possible\s+issues?|key\s+issues?|⚡\s+(?:key|possible))[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|\n---|\Z)/i;
  const sectionMatch = text.match(sectionRe);
  const scanText = sectionMatch ? sectionMatch[1] : text;

  for (const line of scanText.split('\n')) {
    const t = line.trim();
    if (!t || t.length < 10) continue;

    let severity = null;
    if (/🔴|critical|blocker|security.risk|vulnerabilit|sql.inject|xss|rce/i.test(t)) {
      severity = 'critical';
    } else if (/🔒|security\s+concern/i.test(t) && !/:\s*(no|false)/i.test(t)) {
      severity = 'critical';
    } else if (/🟠|major|important|significant|breaking.change/i.test(t)) {
      severity = 'major';
    } else if (/⚡|🟡|possible.bug|possible\s+issue|warning|may\s+cause|could\s+cause/i.test(t)) {
      severity = 'major';
    } else if (/💡|🔵|minor|suggest|consider|improve|nit:/i.test(t)) {
      severity = 'minor';
    }

    if (!severity) continue;
    const description = cleanText(t).slice(0, 250);
    if (description.length < 10) continue;

    issues.push({
      file: '',
      startLine: null,
      endLine: null,
      severity,
      header: description.slice(0, 60),
      description,
      source: 'pr-agent',
    });
  }

  // 补充：从表格行提取（PR-Agent v2 格式）
  const tableRowRe = /\|\s*(🔴|🟠|🟡|⚡|🔒|🔵|💡)[^\|]*\|([^\|]+)\|/g;
  let m;
  while ((m = tableRowRe.exec(text)) !== null) {
    const emoji = m[1];
    const desc = cleanText(m[2]).slice(0, 250);
    if (desc.length < 10) continue;
    const sev = /🔴|🔒/.test(emoji) ? 'critical' : /🟠/.test(emoji) ? 'major' : 'minor';
    issues.push({ file: '', startLine: null, endLine: null, severity: sev, header: desc.slice(0, 60), description: desc, source: 'pr-agent' });
  }

  // 去重
  const seen = new Set();
  return issues.filter((i) => {
    const key = i.description.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

// ── 提取 effort 估算（1-5）───────────────────────────────────────
function extractEffort(text = '') {
  const m = text.match(/effort[^:]*:\s*[`]?(\d)[`]?/i)
    || text.match(/(\d)\s*🔵/);
  return m ? Math.min(5, Math.max(1, Number(m[1]))) : null;
}

// ── 安全问题标记 ─────────────────────────────────────────────────
function extractSecurityFlag(text = '') {
  const m = text.match(/security\s+concerns?[^\n]*:\s*([^\n]+)/i);
  if (!m) return false;
  const val = m[1].toLowerCase().trim();
  return val !== 'no' && val !== 'false' && val !== '';
}

// ── AC checklist（`- [x]` 格式，部分 PR-Agent 配置会输出）────────
function parseChecklistFromMarkdown(text = '') {
  const done = [], notDone = [], needsHumanCheck = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    const doneMatch = t.match(/^[-*]\s+\[x\]\s+(.+)/i);
    if (doneMatch) { done.push(doneMatch[1].trim()); continue; }
    const humanMatch = t.match(/^[-*]\s+\[~\]\s+(.+)/i);
    if (humanMatch) { needsHumanCheck.push(humanMatch[1].trim()); continue; }
    const notDoneMatch = t.match(/^[-*]\s+\[\s\]\s+(.+)/i);
    if (notDoneMatch) { notDone.push(notDoneMatch[1].trim()); continue; }
  }
  return { done, notDone, needsHumanCheck };
}

// ── 总分 ─────────────────────────────────────────────────────────
function extractScore(text = '') {
  const m = text.match(/score[:\s]+(\d+)/i)
    || text.match(/(\d+)\s*\/\s*10\b/);
  if (!m) return null;
  const raw = Number(m[1]);
  return Math.min(100, Math.max(0, raw > 10 ? raw : raw * 10));
}

/**
 * 主入口：解析 fetchPRDetail 结果中 AI bot 的 review
 *
 * @param {object} prDetail - fetchPRDetail 返回值
 * @returns {{
 *   issues: Array<{ severity, header, description, file, startLine, endLine, source }>,
 *   compliance: { done, notDone, needsHumanCheck } | null,
 *   score: number | null,
 *   effort: number | null,
 *   hasSecurityConcern: boolean,
 *   botLogin: string | null,
 *   rawUrl: string | null
 * } | null}
 */
export function parsePrAgentReview(prDetail) {
  const { reviews = [], reviewComments = [] } = prDetail;

  const agentReview = reviews.find((r) => isPrAgentBot(r.user));
  const agentComments = reviewComments.filter((c) => isPrAgentBot(c.user));

  if (!agentReview && agentComments.length === 0) return null;

  const allText = [
    agentReview?.body || '',
    ...agentComments.map((c) => c.body || ''),
  ].join('\n\n');

  const issues = extractIssues(allText);
  const { done, notDone, needsHumanCheck } = parseChecklistFromMarkdown(allText);
  const score = extractScore(allText);
  const effort = extractEffort(allText);
  const hasSecurityConcern = extractSecurityFlag(allText);

  const compliance = (done.length + notDone.length + needsHumanCheck.length) > 0
    ? { done, notDone, needsHumanCheck }
    : null;

  return {
    issues,
    compliance,
    score,
    effort,
    hasSecurityConcern,
    botLogin: agentReview?.user || agentComments[0]?.user || null,
    rawUrl: agentReview?.htmlUrl || null,
  };
}
