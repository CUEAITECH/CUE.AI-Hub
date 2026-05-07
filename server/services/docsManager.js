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

import { callClaude, parseJsonOutput } from './claude.js';

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
    'User-Agent': 'CUE.AI-Hub/1.0',
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
  if (!raw) { console.error('[DocsManager] callClaude 返回 null，API key 缺失或调用失败'); return []; }

  try {
    // 提取第一个 JSON 数组（兼容 markdown 代码块包裹）
    const match = raw.match(/\[[\s\S]*?\]/s) || raw.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/s);
    const jsonStr = match?.[1] || match?.[0];
    if (!jsonStr) { console.error('[DocsManager] LLM 输出未找到 JSON 数组，原始内容:', raw.slice(0, 300)); return []; }
    const tasks = JSON.parse(jsonStr);
    return Array.isArray(tasks) ? tasks : [];
  } catch (e) {
    console.error('[DocsManager] LLM 输出解析失败:', e.message, raw.slice(0, 300));
    return [];
  }
}

const PHASES_SYSTEM_PROMPT = `你是 CUE 项目中枢的 AI 产品经理，负责从开发计划文档中提炼完整的开发阶段路线图，并为每个阶段分配路径图检查节点。

输出严格遵循以下 JSON 对象格式，不输出其他内容：
{
  "phases": [
    { "id": "phase_<英文标识>", "title": "阶段名（中文，10字以内）", "status": "待开始|进行中|已完成" }
  ],
  "nodes": [
    {
      "id": "保留已有节点id或新生成的stage_node_xxx",
      "title": "节点短标题（20字以内）",
      "owner": "负责人（未明确写'待确认'）",
      "acceptance": "验收口径（80字以内）",
      "phaseId": "所属阶段id（必须是上面phases中的id之一）",
      "keywords": ["关键词1", "关键词2"]
    }
  ],
  "nodeAssignments": { "nodeId": "phaseId" }
}

规则：
- phases 数量 3-8 个，覆盖从当前进行中到最终交付的完整路线图
- 近期阶段（已开始/即将开始）：3-5 个节点，描述具体可交付物
- 远期阶段（计划中/未开始）：1-3 个节点，可以相对模糊，以里程碑为主
- 如果某一段计划任务过多（>5个），优先拆分为多个子阶段，而不是把任务堆在同一阶段
- id 用英文下划线格式（如 phase_backend, phase_launch），不能有重复
- nodes 中的 phaseId 必须从 phases 数组中选取，不能创建新 phaseId
- nodeAssignments 覆盖所有 nodes 的 nodeId→phaseId 映射
- 优先复用用户提供的"当前路径图节点"的 id（通过标题语义匹配），未匹配则用新 id
- 从文档的里程碑、阶段划分、进度标注中推断 phases 的 status`;

/**
 * 从文档内容用 LLM 提炼开发阶段划分和路径图节点；LLM 失败时按 sourceDoc 文档名兜底归组
 * @param {Array<{path, name, content}>} docs
 * @param {Array} parsedTasks - 已解析的候选任务（兜底用）
 * @param {Array} existingNodes - 当前路径图节点 [{id, title, phaseId}]（供 LLM 复用 id）
 * @returns {Promise<{phases, nodes, nodeAssignments}|null>}
 */
export async function parsePhasesFromDocs(docs, parsedTasks = [], existingNodes = []) {
  // 1. 尝试 LLM 提炼
  if (docs.length) {
    const docsText = docs.map((d) => `=== ${d.path} ===\n${d.content.slice(0, 2000)}`).join('\n\n');
    const existingNodesText = existingNodes.length
      ? `\n\n=== 当前路径图节点（尽量复用这些节点的 id，通过标题语义匹配）===\n${JSON.stringify(existingNodes.map((n) => ({ id: n.id, title: n.title, phaseId: n.phaseId })))}`
      : '';
    const raw = await callClaude(PHASES_SYSTEM_PROMPT, docsText + existingNodesText);
    if (raw) {
      try {
        const parsed = parseJsonOutput(raw);
        // 新格式：对象 {phases, nodes, nodeAssignments}
        if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.phases) && parsed.phases.length) {
          const phases = parsed.phases
            .filter((p) => p.id && p.title)
            .slice(0, 5)
            .map((p) => ({
              id: String(p.id).replace(/[^\w-]/g, '_').slice(0, 32),
              title: String(p.title).slice(0, 20),
              status: ['待开始', '进行中', '已完成'].includes(p.status) ? p.status : '待开始'
            }));
          if (!phases.length) throw new Error('no valid phases');
          const phaseIdSet = new Set(phases.map((p) => p.id));
          // 处理 nodes：通过标题匹配复用已有节点 id
          const normalizeTitle = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();
          const existingByTitle = new Map(existingNodes.map((n) => [normalizeTitle(n.title), n.id]));
          const nodes = Array.isArray(parsed.nodes)
            ? parsed.nodes.slice(0, 8).map((n) => {
                const normalizedTitle = normalizeTitle(n.title);
                // 复用：完整包含 or 被包含关系
                const matchedId = existingByTitle.get(normalizedTitle)
                  || [...existingByTitle.entries()].find(([t]) => t.includes(normalizedTitle) || normalizedTitle.includes(t))?.[1];
                const id = matchedId || String(n.id || `stage_node_${Math.random().toString(36).slice(2, 8)}`).replace(/[^\w-]/g, '_').slice(0, 64);
                const phaseId = phaseIdSet.has(n.phaseId) ? n.phaseId : phases[0].id;
                return {
                  id,
                  title: String(n.title || '').trim().slice(0, 32),
                  owner: String(n.owner || '').trim().slice(0, 32),
                  acceptance: String(n.acceptance || '').trim().slice(0, 160),
                  phaseId,
                  keywords: Array.isArray(n.keywords) ? n.keywords.slice(0, 10).map((k) => String(k).trim()).filter(Boolean) : [],
                  taskIds: []
                };
              })
            : [];
          const nodeAssignments = typeof parsed.nodeAssignments === 'object' && parsed.nodeAssignments
            ? Object.fromEntries(
                Object.entries(parsed.nodeAssignments)
                  .filter(([, v]) => phaseIdSet.has(v))
              )
            : {};
          return { phases, nodes, nodeAssignments };
        }
        // 兼容旧格式（纯数组）
        if (Array.isArray(parsed) && parsed.length) {
          const phases = parsed
            .filter((p) => p.id && p.title)
            .slice(0, 5)
            .map((p) => ({
              id: String(p.id).replace(/[^\w-]/g, '_').slice(0, 32),
              title: String(p.title).slice(0, 20),
              status: ['待开始', '进行中', '已完成'].includes(p.status) ? p.status : '待开始'
            }));
          if (phases.length) return { phases, nodes: [], nodeAssignments: {} };
        }
      } catch { /* 降级 */ }
    }
  }

  // 2. 兜底：按 sourceDoc 文档名自动归组，每组超过 5 个任务时拆分
  // 生成 phases（phase_doc_N 格式），不生成新节点，只对现有节点做均匀位置分配
  if (parsedTasks.length) {
    const docNames = [...new Set(parsedTasks.map((t) => t.sourceDoc).filter(Boolean))];
    if (docNames.length) {
      const phases = [];
      for (const docPath of docNames) {
        const docTasks = parsedTasks.filter((t) => t.sourceDoc === docPath);
        const baseName = docPath.replace(/^docs\//, '').replace(/\.md$/, '').trim();
        const chunkSize = 5;
        const chunks = Math.ceil(docTasks.length / chunkSize);
        for (let c = 0; c < chunks; c++) {
          const chunk = docTasks.slice(c * chunkSize, (c + 1) * chunkSize);
          const doneCount = chunk.filter((t) => t.status === 'completed').length;
          const status = doneCount === chunk.length ? '已完成' : doneCount > 0 ? '进行中' : '待开始';
          const suffix = chunks > 1 ? `（${c + 1}/${chunks}）` : '';
          phases.push({ id: `phase_doc_${phases.length + 1}`, title: (baseName + suffix).slice(0, 20), status });
        }
        if (phases.length >= 5) break;
      }
      if (phases.length) {
        // 对现有节点做均匀位置分配
        const nodeAssignments = {};
        existingNodes.forEach((n, idx) => {
          nodeAssignments[n.id] = phases[Math.min(
            Math.floor(idx / Math.ceil(Math.max(existingNodes.length, 1) / phases.length)),
            phases.length - 1
          )].id;
        });
        return { phases: phases.slice(0, 5), nodes: [], nodeAssignments };
      }
    }
  }

  return null;
}

function priorityRank(task) {
  if (task.priority === 'P0') return 0;
  if (task.priority === 'P1') return 1;
  return 2;
}

/**
 * 从 LLM 解析出的完整候选任务中，选出本轮适合导入任务板的少量任务。
 * 目标是支撑每日晚会分工，而不是一次性把整个阶段 backlog 灌进 Hub。
 * @param {Array} tasks
 * @param {number} limit
 * @returns {Array}
 */
export function selectDailyDocTasks(tasks, limit = 8) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 20) : 8;
  return [...(tasks || [])]
    .filter((task) => task.status !== 'completed')
    .sort((a, b) => {
      const rank = priorityRank(a) - priorityRank(b);
      if (rank !== 0) return rank;
      if (a.dueDate && b.dueDate) return String(a.dueDate).localeCompare(String(b.dueDate));
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return String(a.sourceDoc || '').localeCompare(String(b.sourceDoc || ''));
    })
    .slice(0, safeLimit);
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
