/**
 * AI 产品经理模块
 * 从目标仓库 docs/ 拉取计划文档 → LLM 解析任务 → 写回阶段进度追踪
 *
 * 流程：
 * 1. fetchProjectDocs    — 列举 + 读取目标仓库 docs/*.md（跳过非计划文档）
 * 2. parseDocsForTasks   — LLM 解析结构化任务列表
 * 3. buildProgressMarkdown — 基于 hub 任务状态生成 阶段进度追踪.md
 * 4. writeProgressToGitHub — PUT API 写回目标仓库
 */

import { callClaude } from './claude.js';

const API_BASE = 'https://api.github.com';
const PROGRESS_DOC_PATH = 'docs/阶段进度追踪.md';

// 跳过这些文档，不从中解析任务
const SKIP_DOC_PATTERNS = [
  '商业计划',
  '用户场景',
  '核心指标',
  '技术选型',
  '功能优先级',
  '阶段进度追踪',
  'README',
];

function authHeaders() {
  const token = process.env.GITHUB_TOKEN;
  return {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'CUE-Project-Hub/1.0',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };
}

async function ghFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, { headers: authHeaders(), ...options });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const resetTime = reset ? new Date(Number(reset) * 1000).toLocaleTimeString('zh-CN') : '未知';
    throw new Error(`GitHub API 速率限制，${reset ? `恢复时间 ${resetTime}` : '请配置 GITHUB_TOKEN'}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${String(path).slice(0, 80)} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * 从目标仓库 docs/ 目录列举并读取计划文档
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Array<{path: string, name: string, content: string}>>}
 */
export async function fetchProjectDocs(owner, repo) {
  let entries;
  try {
    entries = await ghFetch(`/repos/${owner}/${repo}/contents/docs`);
  } catch (err) {
    if (err.message.includes('404')) return [];
    throw err;
  }

  const mdFiles = entries.filter(
    (e) => e.type === 'file' && e.name.endsWith('.md')
      && !SKIP_DOC_PATTERNS.some((p) => e.name.includes(p))
  );

  const docs = await Promise.all(
    mdFiles.map(async (file) => {
      try {
        const data = await ghFetch(`/repos/${owner}/${repo}/contents/${file.path}`);
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return { path: file.path, name: file.name, content, sha: data.sha };
      } catch {
        return null;
      }
    })
  );

  return docs.filter(Boolean);
}

const PARSE_SYSTEM_PROMPT = `你是 CUE 项目中枢的 AI 产品经理助手，负责从开发计划文档中解析结构化任务。

输出严格遵循以下 JSON 数组格式，不要输出其他内容：
[
  {
    "title": "任务标题（简洁，20字以内）",
    "owner": "负责人（中文名或方向标签，未明确写 '待认领'）",
    "priority": "P0|P1|P2",
    "sourceDoc": "来源文档路径",
    "description": "任务描述（50字以内）",
    "dueDate": "截止日期（YYYY-MM-DD 格式，无则留空）",
    "status": "pending|in_progress|completed"
  }
]

判断状态的规则：
- 文档中有 ✅、[x]、"已完成"、"完成" → completed
- 文档中有 🔶、"进行中"、"开发中" → in_progress
- 其余 → pending

注意：
- 每个文档可解析多条任务
- 跳过纯描述性内容（如功能说明、背景），只提取可执行的任务条目
- 如无明确截止日期，dueDate 留空字符串`;

/**
 * 用 LLM 从文档内容解析结构化任务
 * @param {Array<{path, name, content}>} docs
 * @returns {Promise<Array>} 任务列表，失败时返回 []
 */
export async function parseDocsForTasks(docs) {
  if (!docs.length) return [];

  const userPrompt = docs.map((d) =>
    `=== 文档：${d.path} ===\n${d.content.slice(0, 3000)}`
  ).join('\n\n');

  const raw = await callClaude(PARSE_SYSTEM_PROMPT, userPrompt);
  if (!raw) return [];

  try {
    // 提取第一个 JSON 数组
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const tasks = JSON.parse(match[0]);
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    console.error('[DocsManager] LLM 输出解析失败:', raw.slice(0, 200));
    return [];
  }
}

/**
 * 生成阶段进度追踪 Markdown
 * @param {object} project - 项目信息
 * @param {Array} docTasks - 从文档解析的任务（含 sourceDoc）
 * @param {Array} hubTasks - hub 中的任务（store.tasks）
 * @param {Array} todayAssignments - 今日领取记录
 * @param {string} date - YYYY-MM-DD
 * @returns {string}
 */
export function buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, date) {
  const lines = [
    `# ${project.name || project.id} 阶段进度追踪`,
    '',
    `> 最后更新：${date}（由 CUE Project Hub AI 产品经理自动生成）`,
    '',
  ];

  // 按 sourceDoc 分组
  const byDoc = {};
  for (const task of docTasks) {
    const doc = task.sourceDoc || '未归档';
    if (!byDoc[doc]) byDoc[doc] = [];
    byDoc[doc].push(task);
  }

  for (const [doc, tasks] of Object.entries(byDoc)) {
    const docName = doc.replace('docs/', '').replace('.md', '');
    lines.push(`## ${docName}`);
    lines.push('');

    for (const task of tasks) {
      // 优先从 hub 查真实状态
      const hubTask = hubTasks.find(
        (t) => t.title === task.title || (t.sourceDoc === task.sourceDoc && t.title === task.title)
      );
      const status = hubTask?.status || task.status || 'pending';
      const assignedToday = todayAssignments.find((a) => a.taskTitle === task.title);

      const icon = status === 'completed' ? '✅' : status === 'in_progress' || assignedToday ? '🔶' : '⬜';
      const ownerTag = assignedToday ? assignedToday.owner : (hubTask?.owner || task.owner || '');
      const ownerStr = ownerTag ? `（${ownerTag}）` : '';
      const prioStr = task.priority ? ` \`${task.priority}\`` : '';

      lines.push(`- ${icon}${prioStr} **${task.title}**${ownerStr}`);
      if (task.description) lines.push(`  - ${task.description}`);
    }
    lines.push('');
  }

  // 统计
  const total = docTasks.length;
  const done = docTasks.filter((t) => {
    const h = hubTasks.find((ht) => ht.title === t.title);
    return (h?.status || t.status) === 'completed';
  }).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  lines.push('---');
  lines.push(`**总进度：${done}/${total} 完成（${pct}%）** | 数据源：[CUE Project Hub](${process.env.HUB_URL || 'https://hub.cueai.top'})`);

  return lines.join('\n');
}

/**
 * 将进度文档写回目标仓库（create or update）
 * @param {string} owner
 * @param {string} repo
 * @param {string} markdown
 * @returns {Promise<boolean>}
 */
export async function writeProgressToGitHub(owner, repo, markdown) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN 未配置，无法写入文档');

  // 查询当前文件 SHA（更新时需要）
  let existingSha = null;
  try {
    const existing = await ghFetch(`/repos/${owner}/${repo}/contents/${PROGRESS_DOC_PATH}`);
    existingSha = existing.sha;
  } catch (err) {
    if (!err.message.includes('404')) throw err;
    // 文件不存在，正常创建
  }

  const content = Buffer.from(markdown, 'utf8').toString('base64');
  const body = {
    message: `docs: 更新阶段进度追踪 [CUE Hub AI PM]`,
    content,
    ...(existingSha ? { sha: existingSha } : {})
  };

  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${PROGRESS_DOC_PATH}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`写入文档失败 ${res.status}: ${err.slice(0, 200)}`);
  }

  console.log(`[DocsManager] 写回成功: ${owner}/${repo}/${PROGRESS_DOC_PATH}`);
  return true;
}
