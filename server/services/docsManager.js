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

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';   // GFM: task list [x], tables, strikethrough
import { toString } from 'mdast-util-to-string';
import { callClaude, parseJsonOutput } from './claude.js';
import { createId, loadStore, updateStore } from '../store.js';
import { defaultStageChecklist, reassignChecklistPhaseIds } from './stageChecklist.js';
import logger from '../logger.js';

/**
 * Parse markdown text into an mdast AST using remark.
 * @param {string} mdText
 * @returns {import('mdast').Root}
 */
function parseMarkdownDoc(mdText) {
  return unified().use(remarkParse).use(remarkGfm).parse(mdText);
}

/**
 * Walk remark AST and extract headings + their content sections.
 * @param {import('mdast').Root} tree
 * @returns {{ heading: string, level: number, paragraphs: string[], checkItems: {text:string, done:boolean}[] }[]}
 */
function extractSections(tree) {
  const sections = [];
  let currentSection = null;

  for (const node of tree.children) {
    if (node.type === 'heading') {
      currentSection = {
        heading: toString(node),
        level: node.depth,
        checkItems: [],
        paragraphs: [],
      };
      sections.push(currentSection);
    } else if (node.type === 'list' && currentSection) {
      for (const item of node.children) {
        const text = toString(item).trim();
        const isCheckbox = item.checked !== null && item.checked !== undefined;
        if (isCheckbox) {
          currentSection.checkItems.push({ text, done: item.checked === true });
        } else {
          currentSection.paragraphs.push(text);
        }
      }
    } else if (node.type === 'paragraph' && currentSection) {
      currentSection.paragraphs.push(toString(node));
    }
  }

  return sections;
}

/**
 * Convert extracted sections to a compact structured text for LLM consumption.
 * This produces a cleaner, more structured representation than raw markdown.
 * @param {string} mdText
 * @param {number} [maxChars=3000]
 * @returns {string}
 */
function buildStructuredDocContext(mdText, maxChars = 3000) {
  let tree;
  try {
    tree = parseMarkdownDoc(mdText);
  } catch {
    // fallback to raw text slice if AST parsing fails
    return mdText.slice(0, maxChars);
  }

  const sections = extractSections(tree);
  if (!sections.length) return mdText.slice(0, maxChars);

  const lines = [];
  for (const section of sections) {
    const indent = '  '.repeat(Math.max(0, section.level - 1));
    lines.push(`${indent}${'#'.repeat(section.level)} ${section.heading}`);
    for (const para of section.paragraphs) {
      lines.push(`${indent}  ${para}`);
    }
    for (const item of section.checkItems) {
      lines.push(`${indent}  [${item.done ? 'x' : ' '}] ${item.text}`);
    }
  }

  const result = lines.join('\n');
  // If structured output is longer than limit, truncate but prefer structured over raw
  return result.length > maxChars ? result.slice(0, maxChars) : result;
}


const API_BASE = 'https://api.github.com';
const PROGRESS_DOC_PATH = 'docs/阶段进度追踪.md';

// 跳过这些文档，不从中解析任务
const SKIP_DOC_PATTERNS = [
  '商业计划',
  '用户场景',
  '核心指标',
  '技术选型',
  '功能优先级',
  'README',
];

export function isProgressDoc(doc = {}) {
  return String(doc.path || doc.name || '').endsWith(PROGRESS_DOC_PATH)
    || String(doc.name || '').includes('阶段进度追踪');
}

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

const PARSE_SYSTEM_PROMPT = `你是 CUE 项目中枢的 AI 产品经理助手，负责从开发计划文档中解析结构化任务（Task v2 格式）。

输出严格遵循以下 JSON 数组格式，不要输出其他内容：
[
  {
    "title": "任务标题（简洁，20字以内）",
    "owner": "负责人，必须从团队成员中选：田家铭/胡佳涛/罗子宽/林世棋，文档未明确则写 '待认领'，禁止使用'成员A/B/C'等占位符",
    "priority": "P0|P1|P2",
    "sourceDoc": "来源文档路径",
    "deliverableTitle": "所属交付项标题（从文档章节/模块/里程碑推断，20字以内）",
    "description": "技术细节描述（接口名/SDK/模块等，50字以内）",
    "businessNote": "业务语言描述（非技术人员可读，格式：用户能做XX，或：XX角色能XX；30字以内；必须与 description 不同）",
    "acceptance": "独立的可测量完成条件（50字以内；禁止复制或改写 description；必须描述可验证的结果而非实现方式）",
    "dependencies": ["依赖的其他任务标题（精确匹配，无依赖则为空数组 []）"],
    "requirementRefs": ["来源需求编号，如 REQ-L2-001；无则为空数组 []"],
    "dueDate": "截止日期（YYYY-MM-DD 格式，无则留空）",
    "status": "pending|in_progress|completed"
  }
]

判断状态的规则：
- 文档中有 ✅、[x]、「已完成」、「完成」 → completed
- 文档中有 🔶、「进行中」、「开发中」 → in_progress
- 其余 → pending

acceptance 生成规则（重要）：
- 必须描述可验证的结果，不能是对 description 的改写
- 正确示例：「学生端进入课堂后，TRTC 控制台显示该学生已进房，本地麦克风按钮可用」
- 错误示例（照抄技术描述）：「接入 trtc-sdk-v5，调用 enterRoom」
- 无法确定验收条件时写：「[待产品确认验收标准]」（不要留空或复制 description）

businessNote 生成规则：
- 使用「用户能 XX」或「老师/学生能 XX」的格式
- 正确示例：「学生能通过课堂码加入老师的课堂」
- 错误示例（技术语言）：「调用 TRTC SDK 的 enterRoom 接口」

注意：
- 每个文档可解析多条任务
- 跳过纯描述性内容（如功能说明、背景），只提取可执行的任务条目
- 如无明确截止日期，dueDate 留空字符串
- **JSON 字符串值中绝对禁止内嵌英文双引号 "**：如需引述名称/术语，使用中文「」或省略引号；任何字段的值里出现未转义的 " 都会导致整个输出解析失败`;

/**
 * 用 LLM 从文档内容解析结构化任务
 * @param {Array<{path, name, content}>} docs
 * @returns {Promise<Array>} 任务列表，失败时返回 []
 */
export async function parseDocsForTasks(docs) {
  const planDocs = (docs || []).filter((doc) => !isProgressDoc(doc));
  if (!planDocs.length) return [];

  const teamContext = '【团队成员】田家铭（架构/后端/全栈）、胡佳涛（后端/API）、罗子宽（iOS/iPad/iPhone）、林世棋（Web/学生端）。owner 必须从中选，文档无明确负责人写"待认领"。\n\n';
  const userPrompt = teamContext + planDocs.map((d) =>
    `=== 文档：${d.path} ===\n${buildStructuredDocContext(d.content, 3000)}`
  ).join('\n\n');

  // 文档任务解析容易输出长 JSON 数组（40+ 任务、详细描述），把 max_tokens 拉到 8192 防止截断
  const raw = await callClaude(PARSE_SYSTEM_PROMPT, userPrompt, { maxTokens: 8192 });
  if (!raw) { logger.error('[DocsManager] callClaude 返回 null，API key 缺失或调用失败'); return []; }

  const parsed = extractJsonArray(raw);
  if (!parsed) {
    logger.error('[DocsManager] LLM 输出解析失败，原始内容前 500 字:', raw.slice(0, 500));
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * 从 LLM 输出中提取第一个完整 JSON 数组
 * 用括号配对扫描代替非贪婪正则（后者会被数组内嵌套的 ] 误截断）
 * 兼容 ```json``` 代码块包裹
 */
export function extractJsonArray(raw) {
  if (!raw) return null;
  let text = String(raw);
  // 去掉 markdown 代码块包裹
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) text = fenced[1];
  // 找第一个 [，然后用栈匹配到对应的 ]
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1);
        try { return JSON.parse(jsonStr); } catch (e) {
          // 尝试修复 LLM 常见错误：字符串值内未转义的英文双引号
          const repaired = repairLLMJson(jsonStr);
          if (repaired) {
            try {
              const result = JSON.parse(repaired);
              logger.warn('[DocsManager] JSON 经过自动修复后解析成功（建议改进 LLM prompt）');
              return result;
            } catch { /* 继续报错 */ }
          }
          logger.error('[DocsManager] JSON.parse 失败:', e.message);
          const m = e.message.match(/position\s+(\d+)/);
          if (m) {
            const pos = Number(m[1]);
            logger.error('[DocsManager] 错误位置上下文:', JSON.stringify(jsonStr.slice(Math.max(0, pos - 80), pos + 80)));
          }
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 修复 LLM 输出中字符串值内未转义的英文双引号
 * 策略：状态机扫描，进入字符串后遇到 "，向后看：
 *   - 后面紧跟 :  → 当前是 key 的结束引号（不在 value 里），正常关闭
 *   - 后面紧跟 , } ] 或换行+空白+这些 → 当前是 value 的结束引号，正常关闭
 *   - 其他情况 → 视为字符串内未转义的引号，改写为 \"
 */
export function repairLLMJson(input) {
  if (!input) return null;
  const out = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) { out.push(ch); escaped = false; continue; }
    if (ch === '\\') { out.push(ch); escaped = true; continue; }
    if (!inString) {
      out.push(ch);
      if (ch === '"') inString = true;
      continue;
    }
    // inString === true
    if (ch !== '"') { out.push(ch); continue; }
    // 看下一个非空白字符
    let j = i + 1;
    while (j < input.length && /\s/.test(input[j])) j++;
    const next = input[j] || '';
    if (next === ':' || next === ',' || next === '}' || next === ']' || next === '') {
      // 真正的字符串结束
      out.push(ch);
      inString = false;
    } else {
      // 内嵌未转义双引号，转义掉
      out.push('\\"');
    }
  }
  return out.join('');
}

export function parseProgressDoc(markdownContent = '') {
  const items = [];
  for (const line of String(markdownContent || '').split('\n')) {
    const match = line.match(/^[-*]\s*(✅|🔶|⬜)\s*(?:`P[0-2]`\s*)?\*\*(.+?)\*\*/)
      || line.match(/^[-*]\s*(✅|🔶|⬜)\s*(.+?)\s*$/);
    if (!match) continue;
    const docStatus = match[1] === '✅' ? '已完成' : match[1] === '🔶' ? '进行中' : '未开始';
    items.push({
      title: String(match[2] || '').replace(/（.+?）$/, '').trim(),
      docStatus
    });
  }
  return items;
}

const PHASES_SYSTEM_PROMPT = `你是 CUE 项目中枢的 AI 产品经理，负责从开发计划文档中提炼完整的开发阶段路线图，并为每个阶段分配路径图检查节点。

输出严格遵循以下 JSON 对象格式，不输出其他内容：
{
  "phases": [
    {
      "id": "phase_<英文标识>",
      "title": "阶段名（中文，10字以内）",
      "status": "待开始|进行中|已完成",
      "productKeywords": ["从文档中识别出来的该阶段关注的产品域关键词（如客户端骨架阶段可能是 iPad/iPhone/iOS/前端/App；后端阶段可能是 API/Session/服务/后端）。3-8 个，要求能让后续根据 deliverable 标题判断它属于该阶段。"]
    }
  ],
  "nodes": [
    {
      "id": "保留已有节点id或新生成的stage_node_xxx",
      "title": "节点短标题（20字以内）",
      "owner": "负责人，必须从团队成员中选：田家铭/胡佳涛/罗子宽/林世棋，文档未明确则写 '待认领'，禁止使用'成员A/B/C'等占位符",
      "acceptance": "验收口径（80字以内）",
      "phaseId": "所属阶段id（必须是上面phases中的id之一）",
      "keywords": ["关键词1", "关键词2"]
    }
  ],
  "nodeAssignments": { "nodeId": "phaseId" },
  "deliverableAssignments": { "交付项标题（与用户提供的 deliverableTitles 完全一致）": "phaseId" }
}

规则：
- phases 数量 3-8 个，覆盖从当前进行中到最终交付的完整路线图
- 近期阶段（已开始/即将开始）：3-5 个节点，描述具体可交付物
- 远期阶段（计划中/未开始）：1-3 个节点，可以相对模糊，以里程碑为主
- 如果某一段计划任务过多（>5个），优先拆分为多个子阶段，而不是把任务堆在同一阶段
- 节点总数不设上限，完整覆盖文档中所有阶段的交付物
- id 用英文下划线格式（如 phase_backend, phase_launch），不能有重复
- nodes 中的 phaseId 必须从 phases 数组中选取，不能创建新 phaseId
- nodeAssignments 覆盖所有 nodes 的 nodeId→phaseId 映射
- 优先复用用户提供的"当前路径图节点"的 id（通过标题语义匹配），未匹配则用新 id
- 从文档的里程碑、阶段划分、进度标注中推断 phases 的 status
- **deliverableAssignments 必须覆盖用户提供的【交付项标题】列表中的每一个标题（一个不能少）**：
  - key 是原始的 deliverableTitle 字符串（一字不差地复用，含空格、标点、英文大小写）
  - value 是 phases 中的 phaseId
  - 输出前自己核对：deliverableAssignments 的 key 数量必须等于列表长度，遗漏任何一个视为失败
  - 归类原则（项目无关，全靠语义匹配）：
    * 先看 deliverable 标题里出现了什么产品域名词（任何产品的客户端/服务端/特定模块名等），再找该 phase 的 productKeywords 中最匹配的
    * "里程碑/MVP/验收/交付物" 这类修饰词不影响归类——只看 deliverable 标题中真实指向的产品端或模块
    * 不要把某个产品端的 MVP 当成其他端的子目标。比如"客户端 MVP"不归后端 phase，"后端 MVP"不归客户端 phase
    * 若 deliverable 标题不属于任何已规划的 phase，挑文档语义最贴近的，绝不能默认丢到第一个 phase
  - **重要**：每个 phase 的 productKeywords 必须能让上面这个归类原则跑通——即 productKeywords 至少要包含该 phase 涉及的产品端、模块或功能层名词，覆盖到该 phase 下所有 deliverable 标题中可能出现的关键名词`;

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
    const teamContext = '【团队成员】田家铭（架构/后端/全栈）、胡佳涛（后端/API）、罗子宽（iOS/iPad/iPhone）、林世棋（Web/学生端）。owner 必须从中选，文档无明确负责人写"待认领"。\n\n';
    const docsText = docs.map((d) => `=== ${d.path} ===\n${d.content.slice(0, 2000)}`).join('\n\n');
    const existingNodesText = existingNodes.length
      ? `\n\n=== 当前路径图节点（尽量复用这些节点的 id，通过标题语义匹配）===\n${JSON.stringify(existingNodes.map((n) => ({ id: n.id, title: n.title, phaseId: n.phaseId })))}`
      : '';
    // 收集所有 unique deliverableTitle，让 LLM 给出权威 phase 映射
    const uniqueDeliverables = Array.from(new Set(parsedTasks.map((t) => t.deliverableTitle).filter(Boolean)));
    const deliverableContext = uniqueDeliverables.length
      ? `\n\n=== 交付项标题列表（必须在 deliverableAssignments 中为每一个分配一个 phaseId，key 一字不差复用）===\n${JSON.stringify(uniqueDeliverables)}`
      : '';
    // phases 解析也是结构化长输出（phases + nodes + nodeAssignments + deliverableAssignments），拉到 8192
    const raw = await callClaude(PHASES_SYSTEM_PROMPT, teamContext + docsText + existingNodesText + deliverableContext, { maxTokens: 8192 });
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
              status: ['待开始', '进行中', '已完成'].includes(p.status) ? p.status : '待开始',
              productKeywords: Array.isArray(p.productKeywords)
                ? p.productKeywords.slice(0, 10).map((k) => String(k).trim()).filter(Boolean)
                : []
            }));
          if (!phases.length) throw new Error('no valid phases');
          const phaseIdSet = new Set(phases.map((p) => p.id));
          // 处理 nodes：通过标题匹配复用已有节点 id
          const compactTitle = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();
          const existingByTitle = new Map(existingNodes.map((n) => [compactTitle(n.title), n.id]));
          const nodes = Array.isArray(parsed.nodes)
            ? parsed.nodes.slice(0, 40).map((n) => {
                const normalizedTitle = compactTitle(n.title);
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
          // deliverableAssignments：LLM 给出的 deliverableTitle → phaseId 权威映射
          const deliverableAssignments = typeof parsed.deliverableAssignments === 'object' && parsed.deliverableAssignments
            ? Object.fromEntries(
                Object.entries(parsed.deliverableAssignments)
                  .filter(([k, v]) => k && phaseIdSet.has(v))
              )
            : {};
          return { phases, nodes, nodeAssignments, deliverableAssignments };
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
export function selectDailyDocTasks(tasks, limit = 8, selectionContext = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 20) : 8;

  const hubTasks = selectionContext.hubTasks || [];

  // 已完成或进度≥90的 hub 任务标题 → 过滤掉，不再重复导入
  const completedTitles = new Set(
    hubTasks
      .filter((t) => t.status === 'completed' || Number(t.progress || 0) >= 90)
      .map((t) => String(t.title || '').trim())
  );

  // E1：高置信度 commit 覆盖的任务也视为完成，加入 completedTitles（SPEC-E1 防重导入）
  // confidence ≥ 0.75 才算高置信度（TraceLLM benchmark 对标）
  const commitLinks = selectionContext.semanticLinks?.commitTaskLinks || [];
  const hubById = new Map(hubTasks.map((t) => [t.id, t]));
  commitLinks
    .filter((link) => Number(link.confidence || 0) >= 0.75)
    .forEach((link) => {
      const task = hubById.get(link.taskId);
      if (task) completedTitles.add(String(task.title || '').trim());
    });

  // 有 semanticLink commit 覆盖的 hub 任务标题（含低置信度）→ 降权（可能已在进行中）
  const titlesWithCommit = new Set(
    commitLinks.map((link) => hubById.get(link.taskId)?.title).filter(Boolean)
  );

  // 最新晚会 nextTargets → 提权
  const lastReport = Object.values(selectionContext.eveningReports || {})
    .filter((r) => r?.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const nextTargetTitles = new Set(
    (lastReport?.nextTargets || []).map((t) => String(t.taskTitle || '').trim()).filter(Boolean)
  );

  function scoreTask(task) {
    const title = String(task.title || '').trim();
    // priorityRank: P0=0, P1=1, P2=2 → 转为正向分
    let score = task.priority === 'P0' ? 30 : task.priority === 'P1' ? 20 : 10;
    if (nextTargetTitles.has(title)) score += 25; // 晚会推荐加权
    if (task.dueDate) {
      const days = Math.ceil((new Date(task.dueDate).getTime() - Date.now()) / 86400000);
      score += days <= 0 ? 15 : days <= 3 ? 10 : 0;
    }
    if (titlesWithCommit.has(title)) score -= 15; // 已有 commit → 降权
    return score;
  }

  return [...(tasks || [])]
    .filter((task) => {
      if (task.status === 'completed') return false;
      if (completedTitles.has(String(task.title || '').trim())) return false;
      return true;
    })
    .sort((a, b) => scoreTask(b) - scoreTask(a))
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
export function buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, date, deliverables = [], context = {}) {
  const lines = [
    `# ${project.name || project.id} 阶段进度追踪`,
    '',
    `> 最后更新：${date}（由 CUE Project Hub AI 产品经理自动生成）`,
    '',
  ];

  // ── 预计算上下文数据 ─────────────────────────────────────────────
  // A. 有 commit 覆盖的任务 ID 集合（来自 semanticLinks.commitTaskLinks）
  const commitCoveredTaskIds = new Set(
    (context.commitTaskLinks || []).map((link) => link.taskId)
  );

  // B. 近 7 天晚会对账中已交付的任务 ID 集合
  const recentReports = Object.values(context.eveningReports || {})
    .filter((r) => r?.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 7);
  const deliveredTaskIds = new Set(
    recentReports.flatMap((r) =>
      (r.reconciliation || []).filter((row) => row.completed).map((row) => row.taskId)
    )
  );

  // C. 风险映射（key = task.id，由调用方预计算传入）
  const riskByTaskId = context.riskByTaskId || {};

  if (Array.isArray(deliverables) && deliverables.length) {
    const byPhase = {};
    for (const deliverable of deliverables) {
      const key = deliverable.phaseId || '未分阶段';
      if (!byPhase[key]) byPhase[key] = [];
      byPhase[key].push(deliverable);
    }

    for (const [phaseId, items] of Object.entries(byPhase)) {
      lines.push(`## ${phaseId}`);
      lines.push('');
      for (const deliverable of items) {
        const status = deliverable.manualOverride?.status || deliverable.status || '待补证据';
        const icon = status === '已完成' ? '✅' : ['推进中', '进行中', '高风险', '阻塞'].includes(status) ? '🔶' : '⬜';
        const ownerStr = deliverable.owner ? `（${deliverable.owner}）` : '';

        // 计算交付项聚合标签（从子任务 taskIds 汇总）
        const linkedIds = deliverable.taskIds || [];
        let worstRisk = null;
        for (const tid of linkedIds) {
          const r = riskByTaskId[tid];
          if (r && (!worstRisk || r.severity < worstRisk.severity)) worstRisk = r;
        }
        const hasCommit = linkedIds.some((id) => commitCoveredTaskIds.has(id));
        const wasDelivered = linkedIds.some((id) => deliveredTaskIds.has(id));
        // P3（无 git 信号）太普遍，不在文档中展示，避免全部标红
        const riskTag = worstRisk?.severity === 'P1' ? ' 🔴P1'
          : worstRisk?.severity === 'P2' ? ' 🟡P2' : '';
        const commitTag = hasCommit ? ' 📝有提交' : '';
        const deliveredTag = wasDelivered ? ' ✅已交付' : '';

        lines.push(`- ${icon} **${deliverable.title}**${ownerStr}${riskTag}${commitTag}${deliveredTag}`);
        if (deliverable.acceptance) lines.push(`  - ${deliverable.acceptance}`);
        if (worstRisk?.reason && worstRisk.severity !== 'P3') {
          lines.push(`  - ⚠️ ${worstRisk.reason}`);
        }
        if (deliverable.docSuggestComplete) lines.push('  - 文档侧已标记完成，等待 Hub 人工确认。');
      }
      lines.push('');
    }

    const total = deliverables.length;
    const done = deliverables.filter((item) => (item.manualOverride?.status || item.status) === '已完成').length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    lines.push('---');
    lines.push(`**总进度：${done}/${total} 交付项完成（${pct}%）** | 数据源：[CUE Project Hub](${process.env.HUB_URL || 'https://hub.cueai.top'})`);
    return lines.join('\n');
  }

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

  logger.info(`[DocsManager] 写回成功: ${owner}/${repo}/${PROGRESS_DOC_PATH}`);
  return true;
}

/**
 * 调度器专用：轻量 sync-docs
 * 刷新 store.docTasks 快照，并把候选任务导入 hub 任务板（简单标题去重，不做 deliverable 绑定）。
 * 用于 17:45 自动触发，保证晚会前任务板有可领取候选。
 *
 * @param {object} project
 * @param {string} projectId
 * @param {object} deps - { updateStore, createId }
 * @returns {Promise<{imported: number, refreshed: number}>}
 */
// ===== importDocs 任务匹配 helper（从 projectRoutes.js 迁移） =====

// slugId：需要外部注入 createId（fallback 用），所以做成 factory
export function makeSlugId(createId) {
  return function slugId(prefix, value) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^\w㐀-鿿]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    return `${prefix}_${normalized || createId('node').replace(/^node_/, '')}`;
  };
}

/**
 * 按 (sourceDoc + title) 生成稳定、幂等的 task ID（djb2 hash → base36）。
 * 重解析同一文档的同名任务产生相同 ID，不再用随机 nanoid，保证 E1 的任务追溯不归零。
 * @param {string} sourceDoc - 来源文档路径
 * @param {string} title     - 任务标题
 * @returns {string}         - 如 "task_3f2a8c1"
 */
export function stableTaskId(sourceDoc, title) {
  const raw = String(sourceDoc || '') + '|' + String(title || '');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(h, 33) ^ raw.charCodeAt(i)) >>> 0;
  }
  return `task_${h.toString(36).padStart(7, '0')}`;
}

export function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[【】()[\]（）]/g, '').toLowerCase();
}

export function isFuzzyDuplicateTitle(a, b) {
  if (!a || !b) return false;
  const diff = Math.abs(a.length - b.length);
  if (diff > 8) return false;
  return a.includes(b) || b.includes(a);
}

const COMMON_ABBREVS = new Set([
  'api', 'sdk', 'sop', 'sos', 'mvp', 'sku', 'oauth', 'jwt', 'http', 'https',
  'json', 'yaml', 'crud', 'cors', 'rest', 'cli', 'gui', 'ux', 'ui',
  'ci', 'cd', 'dev', 'prod', 'qa', 'env', 'v1', 'v2', 'mr', 'pr', 'pm'
]);

export function extractDistinctiveTokens(text) {
  const ascii = String(text || '').toLowerCase().match(/[a-z][a-z0-9]+/g) || [];
  return ascii.filter((t) => t.length >= 4 && !COMMON_ABBREVS.has(t));
}

export function extractTokens(text) {
  const tokens = new Set();
  const ascii = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  ascii.forEach((t) => tokens.add(t));
  const cjkRuns = String(text || '').match(/[一-鿿]+/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run.slice(i, i + 2));
    }
    if (run.length === 1) tokens.add(run);
  }
  return tokens;
}

export function isTitleConsistent(taskTitle, deliverableTitle) {
  const taskTokens = extractDistinctiveTokens(taskTitle);
  const dlvTokens = extractDistinctiveTokens(deliverableTitle);
  if (!taskTokens.length || !dlvTokens.length) return true;
  const taskLower = String(taskTitle).toLowerCase();
  const dlvLower = String(deliverableTitle).toLowerCase();
  if (taskTokens.some((t) => dlvLower.includes(t))) return true;
  if (dlvTokens.some((t) => taskLower.includes(t))) return true;
  return false;
}

export function jaccardSimilarity(a, b) {
  const ta = extractTokens(a);
  const tb = extractTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 ? inter / union : 0;
}

export function sharedPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export function isLikelyDuplicate(a, b) {
  if (!a || !b) return false;
  const normA = normalizeTitle(a);
  const normB = normalizeTitle(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (Math.abs(normA.length - normB.length) <= 8 && (normA.includes(normB) || normB.includes(normA))) return true;
  if (sharedPrefixLen(normA, normB) >= 4 && jaccardSimilarity(a, b) >= 0.3) return true;
  return false;
}

export function findPhaseByLLMKeywords(deliverableTitle, phases) {
  if (!deliverableTitle || !phases.length) return { phaseId: null, score: 0 };
  const dlvLower = String(deliverableTitle).toLowerCase();
  const dlvTokens = extractTokens(deliverableTitle);
  let best = null;
  let bestScore = 0;
  for (const phase of phases) {
    const keywords = Array.isArray(phase.productKeywords) ? phase.productKeywords : [];
    if (!keywords.length) continue;
    let score = 0;
    for (const kw of keywords) {
      const kwLower = String(kw || '').toLowerCase().trim();
      if (!kwLower) continue;
      if (dlvLower.includes(kwLower)) { score += 2; continue; }
      const kwTokens = extractTokens(kw);
      for (const t of kwTokens) if (dlvTokens.has(t)) { score += 1; break; }
    }
    if (score > bestScore) { bestScore = score; best = phase.id; }
  }
  return { phaseId: best, score: bestScore };
}

export function isBindingPlausible(taskTitle, deliverable, parsedPhasesResult) {
  if (!isTitleConsistent(taskTitle, deliverable.title)) return false;
  if (!deliverable.phaseId || !parsedPhasesResult?.phases?.length) return true;
  const phases = parsedPhasesResult.phases;
  const taskBest = findPhaseByLLMKeywords(taskTitle, phases);
  if (!taskBest.phaseId || taskBest.score < 2) return true;
  if (taskBest.phaseId === deliverable.phaseId) return true;
  const deliverablePhase = phases.find((p) => p.id === deliverable.phaseId);
  let dlvPhaseScore = 0;
  if (deliverablePhase && Array.isArray(deliverablePhase.productKeywords)) {
    const tl = String(taskTitle).toLowerCase();
    const tt = extractTokens(taskTitle);
    for (const k of deliverablePhase.productKeywords) {
      const kl = String(k || '').toLowerCase().trim();
      if (!kl) continue;
      if (tl.includes(kl)) { dlvPhaseScore += 2; continue; }
      const kt = extractTokens(k);
      for (const t of kt) if (tt.has(t)) { dlvPhaseScore += 1; break; }
    }
  }
  return taskBest.score - dlvPhaseScore < 2;
}

export function findPhaseForDeliverable(deliverableTitle, parsedPhasesResult) {
  if (!parsedPhasesResult || !deliverableTitle) return null;
  const { phases = [], nodes = [], deliverableAssignments = {} } = parsedPhasesResult;
  const phaseIdSet = new Set(phases.map((p) => p.id));
  const kw = findPhaseByLLMKeywords(deliverableTitle, phases);
  const normDlv = normalizeTitle(deliverableTitle);
  let llmMap = deliverableAssignments[deliverableTitle];
  if (!llmMap || !phaseIdSet.has(llmMap)) {
    for (const [k, v] of Object.entries(deliverableAssignments)) {
      if (normalizeTitle(k) === normDlv && phaseIdSet.has(v)) { llmMap = v; break; }
    }
  }
  if (llmMap && kw.phaseId && llmMap !== kw.phaseId && kw.score >= 2) {
    const llmPhaseScore = (() => {
      const llmPhase = phases.find((p) => p.id === llmMap);
      if (!llmPhase || !Array.isArray(llmPhase.productKeywords)) return 0;
      const dlvLower = deliverableTitle.toLowerCase();
      const dlvTokens = extractTokens(deliverableTitle);
      let s = 0;
      for (const k of llmPhase.productKeywords) {
        const kl = String(k || '').toLowerCase().trim();
        if (!kl) continue;
        if (dlvLower.includes(kl)) { s += 2; continue; }
        const kt = extractTokens(k);
        for (const t of kt) if (dlvTokens.has(t)) { s += 1; break; }
      }
      return s;
    })();
    if (kw.score - llmPhaseScore >= 2) return kw.phaseId;
  }
  if (llmMap && phaseIdSet.has(llmMap)) return llmMap;
  if (!normDlv) return null;
  if (kw.phaseId && kw.score >= 2) return kw.phaseId;
  const nodeMatch = nodes.find((n) => {
    const normNode = normalizeTitle(n.title || '');
    return normNode === normDlv || normNode.includes(normDlv) || normDlv.includes(normNode);
  });
  if (nodeMatch?.phaseId && phaseIdSet.has(nodeMatch.phaseId)) return nodeMatch.phaseId;
  const dlvTokens = extractTokens(deliverableTitle);
  let bestPhaseId = null;
  let bestScore = 0;
  for (const phase of phases) {
    const phaseTokens = extractTokens(phase.title || '');
    let score = 0;
    for (const t of dlvTokens) if (phaseTokens.has(t)) score++;
    if (score > bestScore) { bestScore = score; bestPhaseId = phase.id; }
  }
  if (bestScore >= 1) return bestPhaseId;
  return kw.phaseId || null;
}

export function findDeliverableByTitle(deliverables = [], title = '') {
  const key = normalizeTitle(title);
  if (!key) return null;
  return deliverables.find((item) => {
    const candidate = normalizeTitle(item.title);
    return candidate === key || candidate.includes(key) || key.includes(candidate);
  }) || null;
}

export function isPlaceholderAcceptance(value) {
  return !String(value || '').trim() || /待补充|未定|todo/i.test(String(value || ''));
}

// 内部 helper：合并 stage checklist（依赖 parsedPhasesResult + defaultStageChecklist + reassignChecklistPhaseIds）
function mergeStageChecklist(draft, parsedPhasesResult) {
  if (!parsedPhasesResult?.phases?.length) return;
  const { phases: newPhases, nodes: newNodes, nodeAssignments } = parsedPhasesResult;
  draft.currentStage = { ...(draft.currentStage || {}), phases: newPhases };
  if (!(newNodes || []).length) return;
  const currentChecklist = draft.currentStage.checklist?.length
    ? draft.currentStage.checklist : defaultStageChecklist;
  const oldById = new Map(currentChecklist.map((node) => [node.id, node]));
  const newNodeSet = new Set(newNodes.map((node) => node.id));
  const mergedNodes = [
    ...newNodes.map((node) => {
      const old = oldById.get(node.id);
      return old
        ? { ...old, title: node.title || old.title, acceptance: node.acceptance || old.acceptance, phaseId: node.phaseId || old.phaseId }
        : node;
    }),
    ...currentChecklist.filter((node) => !newNodeSet.has(node.id) && (node.taskIds?.length > 0))
  ];
  draft.currentStage.checklist = reassignChecklistPhaseIds(mergedNodes, newPhases, nodeAssignments || {});
}

// 应用进度文档建议（用 docs/阶段进度追踪.md 中标记已完成的项给 deliverable 加 suggest 标）
function applyProgressDocSuggestions(draft, docs) {
  const progressDoc = (docs || []).find((doc) => String(doc.name || doc.path || '').includes('阶段进度追踪'));
  if (!progressDoc) return 0;
  const progressItems = parseProgressDoc(progressDoc.content || '');
  let suggested = 0;
  draft.deliverables = draft.deliverables || [];
  for (const item of progressItems) {
    if (item.docStatus !== '已完成') continue;
    const deliverable = findDeliverableByTitle(draft.deliverables, item.title);
    if (!deliverable || deliverable.status === '已完成' || deliverable.manualOverride?.status === '已完成') continue;
    deliverable.docSuggestComplete = true;
    deliverable.docStatus = item.docStatus;
    deliverable.docStatusUpdatedAt = new Date().toISOString();
    suggested++;
  }
  return suggested;
}

export async function importDocsForProject(project, projectId, importLimit) {
  const slugId = makeSlugId(createId);

  const [owner, repo] = (project.githubFullRepo || project.repository || '').split('/');
  if (!owner || !repo) {
    throw new Error('项目未配置 githubFullRepo，请先 PATCH 设置');
  }

  const docs = await fetchProjectDocs(owner, repo);
  if (!docs.length) {
    return { imported: 0, message: 'docs/ 目录无计划文档' };
  }

  const parsedTasks = await parseDocsForTasks(docs);
  if (!parsedTasks.length) {
    return { imported: 0, message: 'LLM 未解析出任务（无 API key 或文档无可执行任务）' };
  }

  const storeSnap = await loadStore();
  const planDocs = docs.filter((doc) => !String(doc.name || doc.path || '').includes('阶段进度追踪'));
  const existingNodes = (storeSnap.currentStage?.checklist?.length
    ? storeSnap.currentStage.checklist : defaultStageChecklist
  ).map((node) => ({ id: node.id, title: node.title, phaseId: node.phaseId }));
  const parsedPhasesResult = await parsePhasesFromDocs(planDocs, parsedTasks, existingNodes);
  const effectiveImportLimit = Number(importLimit ?? process.env.DOC_TASK_IMPORT_LIMIT ?? 8);
  // selectionContext (from PR #21): use real hub state to bias ranking
  //   - hubTasks 过滤已完成任务
  //   - semanticLinks.commitTaskLinks 降权已被 commit 覆盖的任务
  //   - eveningReports[最新].nextTargets 提权晚会指定的下一步
  const selectionContext = {
    hubTasks: (storeSnap.tasks || []).filter((t) => !t.projectId || t.projectId === projectId),
    semanticLinks: storeSnap.semanticLinks || {},
    eveningReports: storeSnap.eveningReports || {}
  };
  const dailyCandidates = selectDailyDocTasks(parsedTasks, effectiveImportLimit, selectionContext);
  // 保证每个 unique deliverableTitle 至少有一个代表任务入候选（让路径图 phase 都有内容，不留空 phase）
  const coveredDeliverables = new Set(dailyCandidates.map((t) => t.deliverableTitle).filter(Boolean));
  const representatives = [];
  for (const parsed of parsedTasks) {
    const dlv = parsed.deliverableTitle;
    if (!dlv || coveredDeliverables.has(dlv)) continue;
    if (parsed.status === 'completed') continue;
    coveredDeliverables.add(dlv);
    representatives.push(parsed);
  }
  const importCandidates = [...dailyCandidates, ...representatives];

  let imported = 0;
  let createdDeliverables = 0;
  let docSuggestions = 0;
  const nextStore = await updateStore((draft) => {
    let existing = draft.tasks || [];
    draft.deliverables = draft.deliverables || [];
    // 找一个与 task 标题产品域一致的 deliverable（用于校验 LLM 给的 deliverableTitle）
    function findConsistentDeliverableForTask(taskTitle) {
      if (!taskTitle) return null;
      return (draft.deliverables || []).find((d) => (
        (!d.projectId || d.projectId === projectId)
        && isTitleConsistent(taskTitle, d.title)
        && extractDistinctiveTokens(taskTitle).some((t) => String(d.title).toLowerCase().includes(t))
      )) || null;
    }

    for (const task of importCandidates) {
      let deliverable = findDeliverableByTitle(draft.deliverables, task.deliverableTitle || task.title);
      // 可信度校验：LLM 给的 deliverable 是否合理（ASCII 标识符 + phase productKeywords）
      if (deliverable && !isBindingPlausible(task.title, deliverable, parsedPhasesResult)) {
        const better = findConsistentDeliverableForTask(task.title);
        deliverable = better; // 没找到就 null（任务暂留为孤儿，下次重绑）
      }
      if (deliverable && !deliverable.phaseId) {
        // 已有 deliverable 但 phaseId 为空，尝试补填
        const resolvedPhaseId = findPhaseForDeliverable(deliverable.title, parsedPhasesResult);
        if (resolvedPhaseId) {
          deliverable.phaseId = resolvedPhaseId;
          deliverable.updatedAt = new Date().toISOString();
        }
      }
      if (!deliverable && (task.deliverableTitle || task.title)) {
        deliverable = {
          id: slugId('deliverable', task.deliverableTitle || task.title),
          projectId,
          phaseId: findPhaseForDeliverable(task.deliverableTitle || task.title, parsedPhasesResult),
          title: task.deliverableTitle || task.title,
          owner: task.owner || '',
          acceptance: (task.acceptance && task.acceptance !== task.description) ? task.acceptance : '',
          keywords: [task.title, task.deliverableTitle, task.sourceDoc].filter(Boolean),
          status: task.status === 'completed' ? '已完成' : task.status === 'in_progress' ? '推进中' : '待补证据',
          progress: task.status === 'completed' ? 100 : 0,  // 进度由子任务聚合，不在此硬编码
          sourceDocPath: task.sourceDoc || '',
          docSuggestComplete: false,
          manualOverride: null,
          taskIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        draft.deliverables.push(deliverable);
        createdDeliverables++;
      }
      // 用 isLikelyDuplicate（精确 + 模糊包含 + Jaccard）去重，防止变体堆积
      const duplicate = existing.find(
        (item) => {
          const sameDoc = !item.sourceDoc || !task.sourceDoc || item.sourceDoc === task.sourceDoc;
          return sameDoc && isLikelyDuplicate(item.title, task.title);
        }
      );
      // 兜底：docs 来的任务必须有 deliverableId，不允许孤儿状态
      if (!deliverable && task.sourceDoc) {
        const fallbackTitle = task.deliverableTitle || task.title;
        deliverable = {
          id: slugId('deliverable', fallbackTitle),
          projectId,
          phaseId: findPhaseForDeliverable(fallbackTitle, parsedPhasesResult),
          title: fallbackTitle,
          owner: task.owner || '',
          acceptance: (task.acceptance && task.acceptance !== task.description) ? task.acceptance : '',
          keywords: [task.title, task.deliverableTitle, task.sourceDoc].filter(Boolean),
          status: task.status === 'completed' ? '已完成' : task.status === 'in_progress' ? '推进中' : '待补证据',
          progress: 0,
          sourceDocPath: task.sourceDoc || '',
          docSuggestComplete: false,
          manualOverride: null,
          taskIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        draft.deliverables.push(deliverable);
        createdDeliverables++;
      }

      if (!duplicate) {
        // stableTaskId：按 (sourceDoc + title) hash 生成稳定 ID，重解析不归零（SPEC-L2 REQ-L2-005）
        const taskId = stableTaskId(task.sourceDoc, task.title);
        const safeAcceptance = (task.acceptance && task.acceptance !== task.description)
          ? task.acceptance
          : (deliverable?.acceptance && deliverable.acceptance !== task.description)
            ? deliverable.acceptance
            : '';
        existing.unshift({
          id: taskId,
          title: task.title,
          // task.owner 永远是 '待认领'：LLM 建议的负责人只是建议，
          // task.owner 应该只反映"实际领取"状态。LLM 的建议保留在 suggestedOwner，前端可选展示
          owner: '待认领',
          suggestedOwner: task.owner || '',
          priority: task.priority || 'P1',
          status: task.status || 'pending',
          description: task.description || '',
          businessNote: task.businessNote || '',
          dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
          requirementRefs: Array.isArray(task.requirementRefs) ? task.requirementRefs : [],
          evidenceRefs: [],
          milestoneId: task.milestoneId || null,
          e2Status: 'not-tested',
          dueDate: task.dueDate || '',
          sourceDoc: task.sourceDoc || '',
          projectId,
          deliverableId: deliverable?.id || null,
          acceptance: safeAcceptance,
          createdAt: new Date().toISOString()
        });
        if (deliverable && !deliverable.taskIds?.includes(taskId)) {
          deliverable.taskIds = [...(deliverable.taskIds || []), taskId];
        }
        imported++;
      } else {
        // 重复任务：只要有 deliverable 且原任务未绑定，就补上 deliverableId
        if (deliverable && !duplicate.deliverableId) {
          duplicate.deliverableId = deliverable.id;
          if (!deliverable.taskIds?.includes(duplicate.id)) {
            deliverable.taskIds = [...(deliverable.taskIds || []), duplicate.id];
          }
        }
        // 可信度校验通过时进一步更新 acceptance 等字段
        if (deliverable && isBindingPlausible(duplicate.title, deliverable, parsedPhasesResult)) {
          duplicate.deliverableId = deliverable.id;
          if (isPlaceholderAcceptance(duplicate.acceptance)) {
            // 只用独立的 acceptance（非 description 复制）；description 不作兜底
            const candidateAcceptance = (task.acceptance && task.acceptance !== task.description) ? task.acceptance
              : (deliverable.acceptance && deliverable.acceptance !== task.description) ? deliverable.acceptance
              : null;
            duplicate.acceptance = candidateAcceptance || duplicate.acceptance || '';
          }
          if (!deliverable.taskIds?.includes(duplicate.id)) {
            deliverable.taskIds = [...(deliverable.taskIds || []), duplicate.id];
          }
        }
      }
    } // end for (const task of importCandidates)
    // 第二遍：只把存量任务重绑到第一遍已经创建的 deliverable，不创建新的
    // 防止幽灵 deliverable（LLM 解析出 40 个任务但只导入 8 个时，剩下 32 个会创建空 deliverable 污染路径图）
    let rebound = 0;
    for (const parsed of parsedTasks) {
      const targetDlvTitle = parsed.deliverableTitle || parsed.title;
      if (!targetDlvTitle) continue;
      const deliverable = findDeliverableByTitle(draft.deliverables, targetDlvTitle);
      if (!deliverable) continue; // 不创建幽灵
      // 补填 phaseId（已有 deliverable 但缺 phase）
      if (!deliverable.phaseId) {
        const resolved = findPhaseForDeliverable(deliverable.title, parsedPhasesResult);
        if (resolved) {
          deliverable.phaseId = resolved;
          deliverable.updatedAt = new Date().toISOString();
        }
      }
      // 用 isLikelyDuplicate 找现有匹配任务，加上可信度校验后再统一绑定
      for (const task of existing) {
        if (task.projectId && task.projectId !== projectId) continue;
        if (!isLikelyDuplicate(task.title, parsed.title)) continue;
        if (!isBindingPlausible(task.title, deliverable, parsedPhasesResult)) continue;
        if (task.deliverableId !== deliverable.id) {
          task.deliverableId = deliverable.id;
          rebound++;
        }
        if (!deliverable.taskIds?.includes(task.id)) {
          deliverable.taskIds = [...(deliverable.taskIds || []), task.id];
        }
      }
    }
    // 第三遍：deliverable 级模糊去重——若两个 deliverable normTitle 互相包含且长度差 ≤ 8，合并
    // 保留 taskIds 多的，合并对方的 taskIds 和被绑的 task.deliverableId
    const dedupedDeliverables = [];
    const mergedMap = new Map(); // oldId → newId
    for (const dlv of draft.deliverables) {
      if (dlv.projectId && dlv.projectId !== projectId) {
        dedupedDeliverables.push(dlv);
        continue;
      }
      const dlvNorm = normalizeTitle(dlv.title);
      const peer = dedupedDeliverables.find((existing) =>
        existing.projectId === projectId
        && (normalizeTitle(existing.title) === dlvNorm
          || isFuzzyDuplicateTitle(normalizeTitle(existing.title), dlvNorm))
      );
      if (peer) {
        // 合并到 peer：选 taskIds 多的为主，少的为附
        const peerCount = (peer.taskIds || []).length;
        const dlvCount = (dlv.taskIds || []).length;
        const winner = peerCount >= dlvCount ? peer : dlv;
        const loser = peerCount >= dlvCount ? dlv : peer;
        winner.taskIds = Array.from(new Set([...(winner.taskIds || []), ...(loser.taskIds || [])]));
        winner.keywords = Array.from(new Set([...(winner.keywords || []), ...(loser.keywords || [])]));
        if (!winner.phaseId && loser.phaseId) winner.phaseId = loser.phaseId;
        mergedMap.set(loser.id, winner.id);
        if (winner === dlv) {
          // 替换 dedupedDeliverables 中的 peer 为 dlv
          const idx = dedupedDeliverables.indexOf(peer);
          dedupedDeliverables[idx] = dlv;
        }
      } else {
        dedupedDeliverables.push(dlv);
      }
    }
    draft.deliverables = dedupedDeliverables;
    // 重映射 tasks/activities/assignments 上被合并掉的 deliverableId
    if (mergedMap.size > 0) {
      draft.tasks = (draft.tasks || []).map((task) => (
        task.deliverableId && mergedMap.has(task.deliverableId)
          ? { ...task, deliverableId: mergedMap.get(task.deliverableId) }
          : task
      ));
      existing = draft.tasks;
      draft.activities = (draft.activities || []).map((activity) => (
        activity.deliverableId && mergedMap.has(activity.deliverableId)
          ? { ...activity, deliverableId: mergedMap.get(activity.deliverableId) }
          : activity
      ));
      draft.assignments = (draft.assignments || []).map((assignment) => (
        assignment.deliverableId && mergedMap.has(assignment.deliverableId)
          ? { ...assignment, deliverableId: mergedMap.get(assignment.deliverableId) }
          : assignment
      ));
    }
    draft._syncDocsLog = { rebound, mergedDeliverables: mergedMap.size };
    draft.tasks = existing;
    if (!draft.docTasks) draft.docTasks = {};
    draft.docTasks[projectId] = parsedTasks;
    mergeStageChecklist(draft, parsedPhasesResult);
    docSuggestions = applyProgressDocSuggestions(draft, docs);
    return draft;
  });

  return {
    imported,
    selected: importCandidates.length,
    totalCandidates: parsedTasks.length,
    importLimit: Math.min(Math.max(Number.isFinite(effectiveImportLimit) ? Math.floor(effectiveImportLimit) : 8, 1), 20),
    message: `已从 ${parsedTasks.length} 个候选任务中选择 ${importCandidates.length} 个适合近期领取的任务导入。`,
    importedTasks: nextStore.tasks.filter((task) => (
      task.projectId === projectId && importCandidates.some((candidate) =>
        candidate.title === task.title && candidate.sourceDoc === task.sourceDoc
      )
    )),
    candidates: parsedTasks,
    phases: parsedPhasesResult?.phases?.length || 0,
    createdDeliverables,
    docSuggestComplete: docSuggestions
  };
}
