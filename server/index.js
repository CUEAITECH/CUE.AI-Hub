import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// 从 .env 文件加载环境变量（不覆盖已由部署环境注入的变量）
{
  const envPath = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env');
  try {
    await access(envPath);
    const content = await readFile(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      // 仅在系统环境中尚未注入该变量时才设置，防止覆盖 ops 注入的凭据
      if (key && !process.env[key]) process.env[key] = value;
    }
  } catch { /* .env 文件不存在时静默跳过 */ }
}
import { createId, loadStore, saveStore, updateStore } from './store.js';
import { generatePlan } from './services/planner.js';
import { reviewChange } from './services/reviewer.js';
import { buildMetrics, scanRisks } from './services/riskEngine.js';
import { parseGitHubEvent, verifyGitHubSignature } from './services/githubWebhook.js';
import { scanLocalGitProject } from './services/localGit.js';
import { scanGitHubProject, hasGitHubConfig, fetchCommitDetail } from './services/githubApi.js';
import { callClaude, parseJsonOutput } from './services/claude.js';
import { buildStageChecklist, normalizeStageName, normalizeStageShortName, defaultStageChecklist, reassignChecklistPhaseIds } from './services/stageChecklist.js';
import {
  isWeComAvailable,
  pushRiskAlerts,
  pushReport,
  sendWeComMarkdown,
  buildPreMeetingWeComMsg,
  buildMeetingSummaryWeComMsg
} from './services/wecom.js';
import { buildOpenApiSpec } from './data/openapi.js';
import {
  fetchProjectDocs,
  parseDocsForTasks,
  parsePhasesFromDocs,
  selectDailyDocTasks,
  buildProgressMarkdown,
  writeProgressToGitHub
} from './services/docsManager.js';
import {
  applyEveningReportProgress,
  buildEveningReport,
  normalizeAssignment,
  normalizeStandup,
  todayText
} from './services/dailyBrief.js';
import { buildHybridAnalysis } from './services/semanticLinker.js';
import { generateAssignmentBrief } from './services/assignmentBrief.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || '127.0.0.1';
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '';
const cueApiKey = process.env.CUE_API_KEY || '';
const hubUrl = process.env.HUB_URL || 'https://hub.cueai.top';
// MEETING_HOUR：每日晚会时间（默认 18），作战包在 15 分钟前自动推送
const meetingHour = Number(process.env.MEETING_HOUR || 18);
// GITHUB_SYNC_INTERVAL_MINUTES：自动同步 GitHub 的间隔，设为 0 可关闭
const githubSyncIntervalMinutes = Math.max(0, Number(process.env.GITHUB_SYNC_INTERVAL_MINUTES || 10));
const githubSyncLimit = Math.max(1, Number(process.env.GITHUB_SYNC_LIMIT || 20));
const githubSyncDiffLimit = Math.max(0, Number(process.env.GITHUB_SYNC_DIFF_LIMIT || 5));

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function setCorsHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-cue-api-key');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  setCorsHeaders(res);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendError(res, status, message, details = undefined) {
  sendJson(res, status, { error: message, details });
}

function hasValidApiKey(req) {
  if (!cueApiKey) return true;
  const provided = req.headers['x-cue-api-key'];
  return typeof provided === 'string' && provided === cueApiKey;
}

function requiresApiKey(req, url) {
  if (!cueApiKey) return false;
  if (!url.pathname.startsWith('/api/')) return false;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  if (url.pathname === '/api/webhooks/github') return false;
  // 企微插件接口无需 API key（企微本身已是内部工具）
  if (url.pathname.startsWith('/api/wecom/')) return false;
  return true;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (!raw.length) return { raw, json: {} };

  try {
    return { raw, json: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { raw, json: null };
  }
}

function normalizeTask(input) {
  const now = new Date().toISOString();
  return {
    id: input.id || createId('task'),
    title: String(input.title || '').trim(),
    owner: String(input.owner || '未分配').trim(),
    status: input.status || '待确认',
    due: input.due || '',
    risk: input.risk || '低',
    progress: Number.isFinite(Number(input.progress)) ? Math.max(0, Math.min(100, Number(input.progress))) : 0,
    signal: input.signal || '等待更新',
    acceptance: input.acceptance || '待补充验收标准',
    createdAt: input.createdAt || now,
    updatedAt: now,
    linkedRefs: Array.isArray(input.linkedRefs) ? input.linkedRefs : [],
    aiProgressSuggestion: input.aiProgressSuggestion || null
  };
}

function getDateParam(url) {
  return url.searchParams.get('date') || todayText();
}

function addDaysText(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatShanghaiTime(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatList(items, formatter, emptyText, limit = 3) {
  const picked = (items || []).slice(0, limit);
  if (!picked.length) return emptyText;
  return picked.map((item, index) => `${index + 1}. ${formatter(item)}`).join('\n');
}

function buildWeComProjectSummary(store, alerts) {
  const metrics = buildMetrics(store, alerts);
  const projects = store.projects || [];
  const project = projects[0] || {};
  const activeTasks = (store.tasks || [])
    .filter((task) => task.status !== '已完成')
    .sort((a, b) => (b.risk === '高') - (a.risk === '高') || (a.progress || 0) - (b.progress || 0));
  const p1Alerts = alerts.filter((alert) => alert.severity === 'P1');
  const recentActivities = (store.activities || []).filter((activity) => activity.type === 'commit');
  const blockingReviews = (store.reviews || []).filter((review) => review.level === 'Block');

  const projectLine = project.githubFullRepo || project.repository
    ? `${project.name || project.repository}（${project.githubFullRepo || project.repository}）`
    : '尚未配置真实仓库';

  const lines = [
    `项目状态：${projectLine}`,
    `同步状态：${project.status || '待同步'}；分支：${project.branch || '未记录'}；最近同步：${formatShanghaiTime(project.lastSyncAt)}`,
    `健康度：${metrics.healthScore} 分；高风险任务：${metrics.highRiskTasks} 个；P1 告警：${metrics.urgentAlerts} 个；待审阅：${metrics.pendingReviews} 条；今日提交：${metrics.commitsToday} 次；站会响应率：${metrics.standupResponseRate}`,
    '',
    '当前重点任务：',
    formatList(
      activeTasks,
      (task) => `${task.owner || '未分配'}「${task.title}」${task.progress ?? 0}% / ${task.status || '待确认'} / 风险${task.risk || '未标注'} / 截止 ${task.due || '未定'}`,
      '暂无未完成任务。',
      5
    ),
    '',
    '优先处理风险：',
    formatList(
      p1Alerts.length ? p1Alerts : alerts.filter((alert) => alert.severity === 'P2'),
      (alert) => `${alert.severity} ${alert.target || '未指定'}：${alert.title}。${alert.detail || ''}`,
      '当前无 P1/P2 风险。',
      5
    ),
    '',
    '最近提交：',
    formatList(
      recentActivities,
      (activity) => `${activity.owner || activity.actor || '未知'}：${activity.title || '未命名提交'}（${formatShanghaiTime(activity.createdAt)}）`,
      '暂无 GitHub 提交记录。',
      5
    ),
    '',
    blockingReviews.length
      ? `AI Review 阻断：${blockingReviews.slice(0, 3).map((review) => `${review.owner || '未知'}「${review.title}」`).join('；')}`
      : 'AI Review 阻断：暂无。'
  ];

  return lines.join('\n');
}

function buildWeComRiskSummary(store, alerts) {
  const metrics = buildMetrics(store, alerts);
  const counts = ['P1', 'P2', 'P3'].map((level) => `${level} ${alerts.filter((alert) => alert.severity === level).length}`).join(' / ');
  const highRiskTasks = (store.tasks || []).filter((task) => task.risk === '高' || task.status === '高风险');
  const staleTasks = alerts.filter((alert) => alert.id?.includes('idle'));
  const noGitTasks = alerts.filter((alert) => alert.id?.includes('no_git'));

  const lines = [
    `风险摘要：${counts}；项目健康度 ${metrics.healthScore} 分。`,
    '',
    '最高优先级告警：',
    formatList(
      alerts.filter((alert) => alert.severity === 'P1'),
      (alert) => `${alert.target || '未指定'}：${alert.title}。${alert.detail || ''}`,
      '当前无 P1 告警。',
      5
    ),
    '',
    '高风险任务：',
    formatList(
      highRiskTasks,
      (task) => `${task.owner || '未分配'}「${task.title}」${task.progress ?? 0}% / ${task.status || '待确认'} / 截止 ${task.due || '未定'}`,
      '当前无高风险任务。',
      5
    ),
    '',
    '需要晚会确认：',
    formatList(
      [...staleTasks, ...noGitTasks],
      (alert) => `${alert.target || '未指定'}：${alert.title}`,
      '暂无需要晚会确认的停滞或无 Git 信号任务。',
      5
    ),
    '',
    '建议动作：晚会先处理 P1 阻断，再让无 Git 信号任务补关联 commit/PR，最后把超过 24 小时无更新的任务拆分、转派或重新领取。'
  ];

  return lines.join('\n');
}

// ─── AI 任务进度扫描 ──────────────────────────────────────────────────────────
const AI_PROGRESS_SYSTEM = `你是任务进度评估助手。根据每个任务的验收标准和关联 Git 提交，评估完成度（0-100 整数）。

评分标准：
- 提交完整覆盖验收标准所有功能点 → 85-100
- 核心功能已实现，边缘情况或测试待处理 → 65-84
- 部分功能实现，主干仍未完成 → 30-64
- 少量相关提交，主体未开始 → 10-29

输出格式：JSON 数组，每项：{"taskId":"task_xxx","progress":75,"reason":"理由（20字内）","hint":"要提高进度还需要补充的内容（30字内）","suggestComplete":false}
suggestComplete 为 true 当且仅当 progress >= 80。hint 说明提高进度需要哪些具体证据或操作（如：补充测试提交、PR合并、验收截图等）。只返回 JSON 数组，不要其他文字。`;

async function estimateTasksProgress(store) {
  const activeTasks = (store.tasks || []).filter((t) => t.status !== '已完成' && t.status !== '已取消');
  if (!activeTasks.length) return [];
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentCommits = (store.activities || []).filter((a) => a.type === 'commit' && a.createdAt >= cutoff);

  // 构建 task → 认领人 mapping（owner 匹配 commit 比关键词更可靠）
  const taskOwners = new Map(); // taskId → Set<owner>
  for (const a of (store.assignments || [])) {
    if (!a.taskId || a.status === '已取消') continue;
    if (!taskOwners.has(a.taskId)) taskOwners.set(a.taskId, new Set());
    taskOwners.get(a.taskId).add(a.owner);
  }

  // semanticLinks 辅助
  const semanticTaskIds = new Map();
  for (const link of ((store.semanticLinks || {}).commitTaskLinks || [])) {
    if (Number(link.confidence) >= 0.4) {
      if (!semanticTaskIds.has(link.taskId)) semanticTaskIds.set(link.taskId, new Set());
      semanticTaskIds.get(link.taskId).add(link.activityId);
    }
  }

  const taskEntries = activeTasks.map((task) => {
    const owners = taskOwners.get(task.id) || new Set();
    const semanticIds = semanticTaskIds.get(task.id) || new Set();
    const titleWords = task.title.toLowerCase().replace(/[^一-龥a-z0-9]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
    const linked = recentCommits.filter((c) => {
      const text = `${c.title || ''} ${(c.files || []).join(' ')}`.toLowerCase();
      return semanticIds.has(c.id)
        || (owners.size > 0 && owners.has(c.owner || c.actor || ''))
        || text.includes(task.id.toLowerCase())
        || titleWords.some((w) => text.includes(w));
    });
    return { task, commits: linked.slice(0, 8) };
  }).filter((e) => e.commits.length > 0);

  if (!taskEntries.length) return [];

  const userPrompt = taskEntries.map(({ task, commits }) => [
    `任务 ${task.id}：${task.title}`,
    `验收：${task.acceptance || '未定'}`,
    `当前进度：${task.progress || 0}%`,
    `认领人：${[...( taskOwners.get(task.id) || [])].join('、') || task.owner || '未知'}`,
    `关联提交：\n${commits.map((c) => `  - [${c.owner || c.actor || '?'}] ${c.title || c.id}`).join('\n')}`
  ].join('\n')).join('\n---\n');

  const raw = await callClaude(AI_PROGRESS_SYSTEM, userPrompt);
  const parsed = raw ? parseJsonOutput(raw) : null;
  return Array.isArray(parsed) ? parsed : [];
}

// ─── 晚报生成（供 API 端点和调度器共用）───────────────────────────────────────
const EVENING_SYSTEM_PROMPT = `你是 CUE Project Hub 的晚报 AI，专为技术负责人生成每日研发晚报。
晚报结构（Markdown 格式）：
1. **今日 GitHub 提交汇总**：列出所有提交者和提交标题，统计提交总数
2. **分工 vs 提交对照**：逐条列出今日领取的分工任务，对应是否有 commit 支撑（有 ✅/无 ⚠️）
3. **AI Review 结论汇总**：今日所有 Review 的级别和评分
4. **未完成领取项 Warning**：状态为"进行中"或"未完成"的领取项，用 ⚠️ 标注
5. **明日建议**：基于今日遗留任务和风险，给出 2-3 条具体建议
要求：语言专业、简洁，用中文，总长不超过 800 字。`;

/**
 * 生成晚报：规则引擎（对账结构）+ LLM（增强文本）+ 快照持久化 + WeCom 推送
 * 同时被 POST /api/reports/evening 路由和 18:00 调度器调用。
 */
async function generateEveningReport(date) {
  const store = await loadStore();
  const generatedAt = new Date();
  const windowStart = new Date(`${addDaysText(date, -1)}T18:00:00+08:00`);

  // 1. 快照：保存生成时刻的提交和分工，供后续对照分析使用（不受后续新 commit 影响）
  const snapshotCommits = (store.activities || []).filter(
    (a) => {
      const createdAt = new Date(a.createdAt || a.date || '');
      return a.type === 'commit' && createdAt >= windowStart && createdAt <= generatedAt;
    }
  );
  const snapshotAssignments = (store.assignments || []).filter((a) => a.date === date);
  const dateReviews = (store.reviews || []).filter(
    (r) => {
      const createdAt = new Date(r.createdAt || '');
      return createdAt >= windowStart && createdAt <= generatedAt;
    }
  );

  // 2. 规则引擎：生成结构化晚报（对账表、nextTargets、进度更新）
  const structuredReport = buildEveningReport(store, date, generatedAt);

  // 3. LLM 增强文本（prompt caching 应用于 EVENING_SYSTEM_PROMPT）
  const commitLines = snapshotCommits.length
    ? snapshotCommits.map((c) => `- ${c.owner || c.actor || '未知'}: ${c.title} (${c.repo || ''})`).join('\n')
    : '今日暂无 commit 记录';
  const assignmentLines = snapshotAssignments.length
    ? snapshotAssignments.map((a) => {
        const hasCommit = snapshotCommits.some((c) => (c.owner || c.actor || '') === a.owner);
        return `- [${a.status}] ${a.owner} 领取「${a.taskTitle}」${a.note ? '（' + a.note + '）' : ''} → ${hasCommit ? '✅ 有提交记录' : '⚠️ 无提交记录'}`;
      }).join('\n')
    : '今日暂无分工领取记录';
  const reviewLines = dateReviews.length
    ? dateReviews.map((r) => `- [${r.level}] ${r.title}（${r.owner}）评分: ${r.score}`).join('\n')
    : '今日暂无 Review 记录';
  const unfinishedLines = snapshotAssignments
    .filter((a) => a.status !== '已完成')
    .map((a) => `- ⚠️ ${a.owner}：「${a.taskTitle}」状态: ${a.status}`)
    .join('\n') || '无未完成领取项';

  const llmText = await callClaude(EVENING_SYSTEM_PROMPT, `请生成 ${date} 的研发晚报。

今日 GitHub 提交（共 ${snapshotCommits.length} 条）：
${commitLines}

今日分工领取 vs 提交对照（共 ${snapshotAssignments.length} 条领取）：
${assignmentLines}

今日 AI Review（共 ${dateReviews.length} 条）：
${reviewLines}

未完成领取项：
${unfinishedLines}`);

  // 4. 合并：结构化数据 + LLM 文本 + 快照字段
  const finalEntry = {
    ...structuredReport,
    report: llmText || structuredReport.report,
    commits: snapshotCommits,
    assignments: snapshotAssignments
  };

  // 5. 应用进度更新（更新 tasks/currentStage/planAdjustments）并保存
  const progressedStore = applyEveningReportProgress(store, structuredReport);
  const alerts = scanRisks(progressedStore);
  await saveStore({
    ...progressedStore,
    eveningReports: {
      ...(progressedStore.eveningReports || {}),
      [date]: finalEntry
    },
    alerts
  });

  // 6. 推送企业微信：使用无表格的结构化格式（企微不支持 Markdown 表格）
  if (isWeComAvailable()) {
    const wecomMsg = buildPreMeetingWeComMsg(finalEntry, hubUrl);
    await sendWeComMarkdown(wecomMsg).catch((err) =>
      console.error('[WeCom] 晚报推送失败:', err.message)
    );
  }

  return finalEntry;
}

// ─── Commit 触发计划调整建议 ──────────────────────────────────────────────────
async function generatePlanAdjustment(activities, store) {
  const SYSTEM = `你是 CUE Project Hub 的 AI PM。根据最新 GitHub commit 和当前任务状态，判断是否需要调整开发计划。
必须输出 JSON，不要输出 Markdown。格式：
{
  "needed": true,
  "scope": "minor|major|progress",
  "summary": "一句话说明",
  "suggestion": "不超过 200 字的具体计划调整",
  "impact": "影响范围",
  "requiresApprovalReason": "如为 major，说明为什么需要人工审批",
  "stageUpdate": {
    "shortName": "总览短名，中文最多14字或英文最多20字符，只写阶段简称，不写项目全名",
    "status": "进行中|高风险|阻塞|已完成",
    "progressDelta": 0,
    "checklist": [
      { "id": "已有或新阶段节点 id", "title": "阶段节点短标题", "owner": "负责人", "keywords": ["commit 关键词"], "acceptance": "验收口径", "phaseId": "所属阶段id（必填，从当前阶段划分中选，不能新建）" }
    ]
  }
}
分类规则：
- progress：只同步进度、补充证据、确认任务推进，可自动执行。
- minor：小范围拆分、补充验收标准、调整当天跟进项，可自动执行。
- major：改变阶段目标、延期、转派关键负责人、调整里程碑或影响多人排期，必须人工审批。
- 如果建议影响阶段展示或路径图，必须给出 stageUpdate；总览只能使用后端生成的 shortName，不能让前端临时裁剪长阶段名。
- stageUpdate.checklist 每个节点必须有 phaseId，从当前阶段划分中选 id，不能新建 phaseId。
- 不需要调整时输出 {"needed": false}。`;
  const activeTasks = (store.tasks || []).filter((t) => t.status !== '已完成').slice(0, 10);
  const stage = normalizeStageName(store.currentStage || {});
  const commitSummary = activities.map((a) => `- ${a.owner}: ${a.title} (${a.repo || ''})`).join('\n');
  const taskSummary = activeTasks.map((t) => `- [${t.status}] ${t.title}（${t.owner}）进度${t.progress}%`).join('\n');
  const stageSummary = `当前阶段：${stage.name}；总览短名：${stage.shortName}；目标日期：${stage.targetDate || '待确认'}；状态：${stage.status || '进行中'}；进度：${Number(stage.progress) || 0}%`;
  const phases = store.currentStage?.phases || [];
  const phaseLine = phases.length ? `当前阶段划分：${phases.map((p) => `${p.id}（${p.title}）`).join('、')}` : '';
  const text = await callClaude(SYSTEM, `${stageSummary}${phaseLine ? '\n' + phaseLine : ''}\n\n最新提交：\n${commitSummary}\n\n当前任务：\n${taskSummary}`);
  const parsed = parseJsonOutput(text);
  if (parsed && parsed.needed === false) return null;
  const scope = ['major', 'minor', 'progress'].includes(parsed?.scope) ? parsed.scope : inferAdjustmentScope(text, activities);
  const stageUpdate = normalizePlanStageUpdate(parsed?.stageUpdate, scope, activities);
  return {
    scope,
    mode: scope === 'major' ? 'approval' : 'auto',
    status: scope === 'major' ? 'pending_approval' : 'auto_applied',
    summary: parsed?.summary || (scope === 'progress' ? '同步 commit 进度信号' : '根据 commit 调整开发计划'),
    suggestion: parsed?.suggestion || text || '',
    impact: parsed?.impact || summarizeAdjustmentImpact(scope, activities),
    requiresApprovalReason: parsed?.requiresApprovalReason || (scope === 'major' ? '涉及阶段目标、负责人或排期变化，需要人工确认。' : ''),
    stageUpdate,
    costReason: `本轮 ${activities.length} 条新 commit 触发一次 AI PM 判断，避免无新提交重复调用。`
  };
}

async function generatePlanAlternatives(item) {
  if (!isAvailable()) return [];
  const SYSTEM = `你是 CUE Project Hub 的 AI PM，负责为需要人工审批的大计划调整提供备选方案。
根据已提出的主方案，生成 2 个方向不同的备选方案（保守 / 激进）。
输出 JSON 数组，不输出其他文字：
[
  {
    "title": "方案标题（10字以内）",
    "approach": "具体调整思路（100字以内）",
    "impact": "影响范围（50字以内）",
    "risk": "高|中|低",
    "stageUpdate": {
      "shortName": "中文最多14字",
      "status": "进行中|高风险|阻塞",
      "progressDelta": 0,
      "checklist": [
        { "id": "节点id", "title": "短标题", "owner": "负责人", "keywords": [], "acceptance": "验收口径", "phaseId": "所属阶段id（必填，从当前阶段划分中选）" }
      ]
    }
  }
]`;
  const currentPhases = (item.stageUpdate?.phases || []);
  const phaseLine = currentPhases.length ? `当前阶段划分：${currentPhases.map((p) => `${p.id}（${p.title}）`).join('、')}\n` : '';
  const userPrompt = `${phaseLine}主方案：${item.suggestion || ''}\n原因：${item.requiresApprovalReason || ''}\n影响：${item.impact || ''}`;
  const text = await callClaude(SYSTEM, userPrompt);
  const parsed = parseJsonOutput(text);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 2).map((opt, i) => ({
    id: i + 2,
    title: String(opt.title || `备选方案${i + 2}`).slice(0, 20),
    approach: String(opt.approach || '').slice(0, 200),
    impact: String(opt.impact || '').slice(0, 100),
    risk: ['高', '中', '低'].includes(opt.risk) ? opt.risk : '中',
    stageUpdate: opt.stageUpdate || null
  }));
}

function normalizePlanStageUpdate(stageUpdate, scope, activities = []) {
  const input = stageUpdate && typeof stageUpdate === 'object' ? stageUpdate : {};
  const fallbackShortName = inferStageShortNameFromActivities(activities);
  const normalized = {};
  const shortName = String(input.shortName || input.displayName || fallbackShortName || '').trim();
  if (shortName) normalized.shortName = normalizeStageShortName(shortName);
  if (['进行中', '高风险', '阻塞', '已完成'].includes(input.status)) normalized.status = input.status;
  if (Number.isFinite(Number(input.progressDelta))) {
    normalized.progressDelta = Math.max(-30, Math.min(30, Number(input.progressDelta)));
  } else if (scope === 'progress') {
    normalized.progressDelta = activities.length ? Math.min(8, activities.length * 2) : 1;
  }
  if (Array.isArray(input.checklist)) {
    normalized.checklist = input.checklist
      .filter((item) => item && item.title)
      .slice(0, 8)
      .map((item) => ({
        id: String(item.id || createId('stage_node')).replace(/[^\w-]/g, '_').slice(0, 64),
        title: String(item.title || '').trim().slice(0, 32),
        owner: String(item.owner || '未指定').trim().slice(0, 32),
        keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, 10).map((keyword) => String(keyword).trim()).filter(Boolean) : [],
        acceptance: String(item.acceptance || item.title || '').trim().slice(0, 160),
        ...(item.phaseId ? { phaseId: String(item.phaseId).replace(/[^\w-]/g, '_').slice(0, 64) } : {})
      }));
  }
  return Object.keys(normalized).length ? normalized : null;
}

function inferStageShortNameFromActivities(activities = []) {
  const text = activities.map((activity) => `${activity.title || ''} ${(activity.files || []).join(' ')}`).join(' ').toLowerCase();
  if (/trtc|asr|session|usersig|课堂/.test(text)) return 'MVP / TRTC 联调';
  if (/review|block|escalate|审阅/.test(text)) return 'AI Review 闭环';
  if (/standup|meeting|晚会|分工/.test(text)) return '晚会分工闭环';
  return '';
}

function applyPlanAdjustmentToStage(store, adjustment) {
  const stageUpdate = adjustment?.stageUpdate;
  if (!stageUpdate) return store;
  const currentStage = normalizeStageName(store.currentStage || {});
  const nextStage = {
    ...currentStage,
    shortName: stageUpdate.shortName || currentStage.shortName,
    status: stageUpdate.status || currentStage.status,
    progress: Math.max(0, Math.min(100, Number(currentStage.progress) + (Number(stageUpdate.progressDelta) || 0))),
    updatedAt: new Date().toISOString()
  };
  if (Array.isArray(stageUpdate.checklist) && stageUpdate.checklist.length) {
    const existing = Array.isArray(currentStage.checklist) ? currentStage.checklist : [];
    const byId = new Map(existing.map((item) => [item.id, item]));
    stageUpdate.checklist.forEach((item) => {
      byId.set(item.id, { ...(byId.get(item.id) || {}), ...item });
    });
    nextStage.checklist = [...byId.values()];
  }
  if (Array.isArray(stageUpdate.phases) && stageUpdate.phases.length) {
    nextStage.phases = stageUpdate.phases;
  }
  // 确保所有节点 phaseId 有效，并做节点数 rebalance
  const effectivePhases = nextStage.phases?.length ? nextStage.phases : defaultPhases;
  if (Array.isArray(nextStage.checklist)) {
    nextStage.checklist = reassignChecklistPhaseIds(nextStage.checklist, effectivePhases, {});
  }
  return {
    ...store,
    currentStage: normalizeStageName(nextStage)
  };
}

function buildPlanAdjustmentRecord(adjustment, activities, source) {
  return {
    id: createId('adjust'),
    date: todayText(),
    trigger: activities.map((activity) => activity.title).join('; '),
    triggerCount: activities.length,
    source,
    ...adjustment,
    appliedAt: adjustment.status === 'auto_applied' && adjustment.stageUpdate ? new Date().toISOString() : undefined,
    createdAt: new Date().toISOString()
  };
}

async function persistPlanAdjustment(adjustment, activities, source) {
  if (!adjustment) return null;
  const record = buildPlanAdjustmentRecord(adjustment, activities, source);
  await updateStore((draft) => {
    let nextDraft = draft;
    if (record.status === 'auto_applied') {
      nextDraft = applyPlanAdjustmentToStage(draft, record);
    }
    nextDraft.planAdjustments = nextDraft.planAdjustments || [];
    nextDraft.planAdjustments.unshift(record);
    nextDraft.planAdjustments = nextDraft.planAdjustments.slice(0, 50);
    return nextDraft;
  });
  return record;
}

function inferAdjustmentScope(text, activities = []) {
  const raw = `${text || ''} ${activities.map((a) => a.title || '').join(' ')}`;
  if (/延期|里程碑|阶段目标|转派|负责人|排期|范围|降级|上线|发布|阻塞/i.test(raw)) return 'major';
  if (/进度|完成|提交|同步|证据/i.test(raw)) return 'progress';
  return 'minor';
}

function summarizeAdjustmentImpact(scope, activities = []) {
  if (scope === 'major') return '可能影响阶段目标、负责人或排期。';
  if (scope === 'progress') return '只更新任务进度信号和 commit 证据。';
  return `影响 ${activities.length || 1} 条 commit 对应的当天跟进项。`;
}

async function syncGitHubProjectIntoStore(project, scanOptions = {}) {
  if (!hasGitHubConfig(project)) {
    throw new Error(`项目未配置 githubOwner，请先设置 githubOwner 和 repository`);
  }

  const scan = await scanGitHubProject(project, {
    since: scanOptions.since || '14 days ago',
    limit: Number(scanOptions.limit || 15),
    diffLimit: Number(scanOptions.diffLimit ?? 8)
  });
  const beforeStore = await loadStore();
  const existingActivityIds = new Set((beforeStore.activities || []).map((activity) => activity.id));
  const existingReviewIds = new Set((beforeStore.reviews || []).map((review) => review.id));
  const reviewCandidates = scan.activities.filter((activity) => (
    activity.type === 'commit'
    && !existingReviewIds.has(`review_${activity.sha}`)
    && String(activity.title || '').trim().length > 0
  ));
  const commitReviews = await Promise.all(
    reviewCandidates.map(async (activity) => ({
      id: `review_${activity.sha}`,
      projectId: project.id,
      activityId: activity.id,
      sha: activity.sha,
      shortSha: activity.shortSha,
      commitUrl: activity.url,
      actor: activity.actor,
      files: activity.files || [],
      humanDecision: null,
      ...await reviewChange({
        repo: activity.repo,
        title: activity.title,
        owner: activity.owner,
        diff: activity.diff || activity.files.join('\n'),
        files: activity.files
      })
    }))
  );
  const lightweightActivities = scan.activities.map(({ diff, ...activity }) => activity);
  let addedActivityCount = 0;
  let addedReviewCount = 0;

  const nextStore = await updateStore((draft) => {
    draft.projects = (draft.projects || []).map((item) =>
      item.id === project.id
        ? {
            ...item,
            branch: scan.branch,
            status: '已同步 (GitHub)',
            lastSyncAt: new Date().toISOString(),
            commitCount: scan.commitCount,
            dirtyFileCount: 0
          }
        : item
    );
    const retainedActivities = (draft.activities || []).filter((activity) => activity.projectId !== project.id);
    const mergedActivityIds = new Set();
    const projectActivities = lightweightActivities.filter((activity) => {
      if (mergedActivityIds.has(activity.id)) return false;
      mergedActivityIds.add(activity.id);
      return true;
    });
    const newReviews = commitReviews.filter((review) => !existingReviewIds.has(review.id));
    addedActivityCount = projectActivities.filter((activity) => !existingActivityIds.has(activity.id)).length;
    addedReviewCount = newReviews.length;
    draft.activities = [...projectActivities, ...retainedActivities].slice(0, 700);
    draft.reviews = [...newReviews, ...(draft.reviews || [])].slice(0, 300);
    return draft;
  });

  const alerts = scanRisks(nextStore);
  const newActivities = lightweightActivities.filter((activity) => !existingActivityIds.has(activity.id));
  if (newActivities.length > 0) {
    generatePlanAdjustment(newActivities, nextStore).then((adjustment) => {
      if (!adjustment) return null;
      return persistPlanAdjustment(adjustment, newActivities, 'github-sync');
    }).catch((err) => console.error('[PlanAdjust/GitHubSync]', err.message));

    // 有新 commit → 异步更新任务进度（不阻塞响应）
    estimateTasksProgress(nextStore).then((results) => {
      if (!results.length) return;
      return updateStore((draft) => {
        for (const r of results) {
          const task = draft.tasks.find((t) => t.id === r.taskId);
          if (!task) continue;
          const newProgress = Math.max(0, Math.min(100, Number(r.progress) || 0));
          task.progress = Math.max(task.progress || 0, newProgress);
          task.aiProgressSuggestion = {
            progress: newProgress,
            reason: String(r.reason || '').slice(0, 80),
            hint: String(r.hint || '').slice(0, 100),
            suggestComplete: !!r.suggestComplete,
            updatedAt: new Date().toISOString()
          };
        }
        return draft;
      });
    }).catch((err) => console.error('[AIProgress/GitHubSync]', err.message));
  }
  return {
    project: nextStore.projects.find((item) => item.id === project.id),
    source: 'github-api',
    addedActivities: addedActivityCount,
    addedReviews: addedReviewCount,
    activities: lightweightActivities,
    reviews: commitReviews,
    metrics: buildMetrics(nextStore, alerts),
    alerts
  };
}

function githubSyncErrorHint(project, err) {
  const msg = err.message || '';
  const is404 = msg.includes('404');
  const is403 = msg.includes('403') || msg.includes('速率限制');
  const hasToken = Boolean(process.env.GITHUB_TOKEN);
  if (is404) {
    return hasToken
      ? `已配置 GITHUB_TOKEN，但无法访问仓库 "${project.githubFullRepo}"。请确认 token 的 Resource owner 是组织、已选择该仓库，并完成组织 SSO/审批授权。`
      : `仓库 "${project.githubFullRepo}" 不存在或为私有仓库。私有仓库需要在 .env 中配置 GITHUB_TOKEN。`;
  }
  if (is403) return '已触发 GitHub API 速率限制（匿名 60 次/小时）。配置 GITHUB_TOKEN 可提升至 5000 次/小时。';
  return msg;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, name: 'CUE Project Hub', time: new Date().toISOString() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const store = await loadStore();
    const alerts = scanRisks(store);
    const currentStage = normalizeStageName(store.currentStage || {});
    sendJson(res, 200, {
      ...store,
      currentStage,
      alerts,
      metrics: buildMetrics(store, alerts),
      stageChecklist: buildStageChecklist({ ...store, currentStage })
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/stage/checklist') {
    const store = await loadStore();
    sendJson(res, 200, buildStageChecklist(store));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/refresh-analysis') {
    const store = await loadStore();
    const analysis = await buildHybridAnalysis(store);
    const nextStore = await updateStore((draft) => ({
      ...draft,
      semanticLinks: analysis.semanticLinks || {},
      riskAnalyses: analysis.riskAnalyses || [],
      healthAnalysis: analysis.healthAnalysis || null,
      aiAnalysisUpdatedAt: analysis.generatedAt
    }));
    const alerts = scanRisks(nextStore);
    sendJson(res, 200, {
      semanticLinks: nextStore.semanticLinks,
      riskAnalyses: nextStore.riskAnalyses,
      healthAnalysis: nextStore.healthAnalysis,
      aiAnalysisUpdatedAt: nextStore.aiAnalysisUpdatedAt,
      metrics: buildMetrics(nextStore, alerts),
      alerts,
      stageChecklist: buildStageChecklist(nextStore)
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const store = await loadStore();
    const status = url.searchParams.get('status');
    const tasks = status ? store.tasks.filter((t) => t.status === status) : store.tasks;
    sendJson(res, 200, { tasks });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/members') {
    const store = await loadStore();
    sendJson(res, 200, { members: store.members });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/openapi.json') {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${port}`;
    const serverUrl = `${proto}://${host}`;
    sendJson(res, 200, buildOpenApiSpec(serverUrl));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/assignments') {
    const store = await loadStore();
    const date = getDateParam(url);
    sendJson(res, 200, {
      date,
      assignments: (store.assignments || []).filter((assignment) => assignment.date === date)
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/assignments') {
    const { json } = await readBody(req);
    const store = await loadStore();
    const assignment = normalizeAssignment(json || {}, store);
    if (!assignment.owner || !assignment.taskTitle) {
      sendError(res, 400, 'owner and task are required');
      return true;
    }

    // 先保存，立即响应，brief 异步生成
    const nextStore = await updateStore((draft) => {
      draft.assignments = [assignment, ...(draft.assignments || [])].slice(0, 500);
      return draft;
    });
    sendJson(res, 201, {
      assignment,
      assignments: (nextStore.assignments || []).filter((item) => item.date === assignment.date)
    });

    // 异步生成 brief，完成后回写
    const task = (store.tasks || []).find((item) => item.id === assignment.taskId) || null;
    generateAssignmentBrief({ task, owner: assignment.owner, note: assignment.note, store })
      .then((brief) => updateStore((draft) => {
        const idx = (draft.assignments || []).findIndex((a) => a.id === assignment.id);
        if (idx >= 0) {
          draft.assignments[idx].brief = brief;
          draft.assignments[idx].briefGeneratedBy = brief.generatedBy;
        }
        return draft;
      }))
      .catch((err) => console.error('[Brief]', err.message));

    return true;
  }

  // POST /api/assignments/:id/brief — 重新触发细则生成（生成失败时用）
  if (req.method === 'POST' && url.pathname.startsWith('/api/assignments/') && url.pathname.endsWith('/brief')) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
    const store = await loadStore();
    const assignment = (store.assignments || []).find((a) => a.id === id);
    if (!assignment) { sendError(res, 404, 'assignment not found'); return true; }
    const task = (store.tasks || []).find((t) => t.id === assignment.taskId) || null;
    sendJson(res, 202, { message: '细则生成已触发', assignments: store.assignments });
    generateAssignmentBrief({ task, owner: assignment.owner, note: assignment.note, store })
      .then((brief) => updateStore((draft) => {
        const idx = (draft.assignments || []).findIndex((a) => a.id === id);
        if (idx >= 0) { draft.assignments[idx].brief = brief; draft.assignments[idx].briefGeneratedBy = brief.generatedBy; }
        return draft;
      }))
      .catch((err) => console.error('[Brief/Retry]', err.message));
    return true;
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/api/assignments/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const { json } = await readBody(req);
    let updated = null;
    const nextStore = await updateStore((draft) => {
      const index = (draft.assignments || []).findIndex((assignment) => assignment.id === id);
      if (index === -1) return draft;
      updated = normalizeAssignment({
        ...draft.assignments[index],
        ...(json || {}),
        id,
        createdAt: draft.assignments[index].createdAt
      }, draft);
      draft.assignments[index] = updated;
      return draft;
    });
    if (!updated) sendError(res, 404, 'assignment not found');
    else sendJson(res, 200, {
      assignment: updated,
      assignments: (nextStore.assignments || []).filter((item) => item.date === updated.date)
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/standups') {
    const store = await loadStore();
    const date = getDateParam(url);
    sendJson(res, 200, {
      date,
      standups: (store.standups || []).filter((standup) => standup.date === date)
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/standups') {
    const { json } = await readBody(req);
    const standup = normalizeStandup(json || {});
    if (!standup.owner) {
      sendError(res, 400, 'owner is required');
      return true;
    }

    const nextStore = await updateStore((draft) => {
      const existingIndex = (draft.standups || []).findIndex((item) => (
        item.date === standup.date && item.owner === standup.owner
      ));
      if (existingIndex >= 0) {
        draft.standups[existingIndex] = {
          ...draft.standups[existingIndex],
          ...standup,
          id: draft.standups[existingIndex].id,
          createdAt: draft.standups[existingIndex].createdAt
        };
      } else {
        draft.standups = [standup, ...(draft.standups || [])].slice(0, 500);
      }
      return draft;
    });
    sendJson(res, 201, {
      standup,
      standups: (nextStore.standups || []).filter((item) => item.date === standup.date)
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const store = await loadStore();
    sendJson(res, 200, { projects: store.projects || [] });
    return true;
  }

  // 共用同步逻辑：有 githubOwner → GitHub API；否则 → 本地 git（仅作为降级）
  async function runProjectSync(project, scanOptions) {
    if (hasGitHubConfig(project)) {
      return scanGitHubProject(project, scanOptions);
    }
    if (project.localPath) {
      console.warn(`[Sync] 项目 ${project.id} 未配置 githubOwner，降级到本地 git（建议配置远端）`);
      return scanLocalGitProject(project, scanOptions);
    }
    throw new Error(`项目 "${project.name || project.id}" 既未配置 githubOwner，也没有 localPath，无法同步`);
  }

  // PATCH /api/projects/:id — 更新项目配置（githubOwner、githubFullRepo 等）
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/projects/') &&
      !url.pathname.includes('/sync')) {
    const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
    const { json } = await readBody(req);
    if (!json) { sendError(res, 400, 'invalid json'); return true; }
    const nextStore = await updateStore((draft) => {
      const idx = (draft.projects || []).findIndex((p) => p.id === projectId);
      if (idx === -1) return draft;
      // 只允许更新安全字段，不允许覆盖 id
      const allowed = ['name', 'repository', 'githubOwner', 'githubFullRepo', 'localPath', 'summary'];
      const patch = Object.fromEntries(Object.entries(json).filter(([k]) => allowed.includes(k)));
      const current = draft.projects[idx];
      const repoChanged = ['repository', 'githubOwner', 'githubFullRepo', 'localPath']
        .some((key) => Object.hasOwn(patch, key) && patch[key] !== current[key]);
      const shouldResetSync = repoChanged || json.resetSync === true;
      draft.projects[idx] = {
        ...current,
        ...patch,
        ...(shouldResetSync
          ? {
              branch: '',
              status: '待同步',
              lastSyncAt: '',
              commitCount: 0,
              dirtyFileCount: 0
            }
          : {})
      };
      return draft;
    });
    const project = (nextStore.projects || []).find((p) => p.id === projectId);
    if (!project) { sendError(res, 404, 'project not found'); return true; }
    sendJson(res, 200, { project });
    return true;
  }

  // POST /api/projects/:id/sync-github — 明确走 GitHub API（忽略 localPath）
  if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-github')) {
    const parts = url.pathname.split('/');
    const projectId = decodeURIComponent(parts[3] || '');
    const store = await loadStore();
    const project = (store.projects || []).find((item) => item.id === projectId);
    if (!project) { sendError(res, 404, 'project not found'); return true; }
    if (!hasGitHubConfig(project)) {
      sendError(res, 400, `项目未配置 githubOwner，请先 PATCH /api/projects/${projectId} 设置 githubOwner 和 repository`);
      return true;
    }

    try {
      const result = await syncGitHubProjectIntoStore(project, {
        since: url.searchParams.get('since') || '14 days ago',
        limit: Number(url.searchParams.get('limit') || 15)
      });
      sendJson(res, 200, result);
      return true;
    } catch (err) {
      sendError(res, 422, 'GitHub 同步失败', githubSyncErrorHint(project, err));
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-local-git')) {
    const parts = url.pathname.split('/');
    const projectId = decodeURIComponent(parts[3] || '');
    const store = await loadStore();
    const project = (store.projects || []).find((item) => item.id === projectId);

    if (!project) {
      sendError(res, 404, 'project not found');
      return true;
    }

    const scanOptions = {
      since: url.searchParams.get('since') || '14 days ago',
      limit: Number(url.searchParams.get('limit') || 12)
    };
    // 自动升级：有 githubOwner 则走 GitHub API
    const scan = await runProjectSync(project, scanOptions);

    const commitReviews = await Promise.all(
      scan.activities
        .filter((activity) => activity.type === 'commit' && String(activity.title || '').trim().length > 0)
        .map(async (activity) => ({
          id: `review_${activity.sha}`,
          projectId: project.id,
          activityId: activity.id,
          ...await reviewChange({
            repo: project.repository,
            title: activity.title,
            owner: activity.owner,
            diff: activity.diff || activity.files.join('\n'),
            files: activity.files
          })
        }))
    );
    const lightweightActivities = scan.activities.map(({ diff, ...activity }) => activity);
    let addedActivityCount = 0;
    let addedReviewCount = 0;

    const nextStore = await updateStore((draft) => {
      draft.projects = (draft.projects || []).map((item) => (
        item.id === project.id
          ? {
              ...item,
              branch: scan.branch,
              status: scan.dirtyFileCount ? '有未提交改动' : '已同步',
              lastSyncAt: new Date().toISOString(),
              commitCount: scan.commitCount,
              dirtyFileCount: scan.dirtyFileCount
            }
          : item
      ));

      const existingActivityIds = new Set((draft.activities || []).map((activity) => activity.id));
      const existingReviewIds = new Set((draft.reviews || []).map((review) => review.id));
      const retainedActivities = (draft.activities || []).filter((activity) => (
        activity.projectId !== project.id || activity.type !== 'working_tree'
      ));
      const newActivities = lightweightActivities.filter((activity) => (
        activity.type === 'working_tree' || !existingActivityIds.has(activity.id)
      ));
      const newReviews = commitReviews.filter((review) => !existingReviewIds.has(review.id));
      addedActivityCount = newActivities.length;
      addedReviewCount = newReviews.length;

      draft.activities = [...newActivities, ...retainedActivities].slice(0, 700);
      draft.reviews = [...newReviews, ...(draft.reviews || [])].slice(0, 300);
      return draft;
    });

    const alerts = scanRisks(nextStore);
    sendJson(res, 200, {
      project: nextStore.projects.find((item) => item.id === project.id),
      addedActivities: addedActivityCount,
      addedReviews: addedReviewCount,
      activities: lightweightActivities,
      reviews: commitReviews,
      metrics: buildMetrics(nextStore, alerts),
      alerts
    });
    return true;
  }

  // POST /api/projects/:id/sync-docs — 从目标仓库 docs/ 解析任务并导入 hub
  if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-docs')) {
    const projectId = url.pathname.split('/')[3];
    const store = await loadStore();
    const project = (store.projects || []).find((p) => p.id === projectId);
    if (!project) { sendError(res, 404, '项目不存在'); return true; }

    const { owner, repo } = project.githubFullRepo?.includes('/')
      ? { owner: project.githubFullRepo.split('/')[0], repo: project.githubFullRepo.split('/')[1] }
      : { owner: project.githubOwner || '', repo: project.repository || '' };

    if (!owner || !repo) { sendError(res, 400, '项目未配置 githubFullRepo，请先 PATCH 设置'); return true; }

    const docs = await fetchProjectDocs(owner, repo);
    if (!docs.length) { sendJson(res, 200, { imported: 0, message: 'docs/ 目录无计划文档' }); return true; }

    const parsedTasks = await parseDocsForTasks(docs);
    if (!parsedTasks.length) { sendJson(res, 200, { imported: 0, message: 'LLM 未解析出任务（无 API key 或文档无可执行任务）' }); return true; }
    // 读取现有节点供 LLM 复用 id，避免丢失 commit/task 证据关联
    const storeSnap = await loadStore();
    const existingNodes = (storeSnap.currentStage?.checklist?.length
      ? storeSnap.currentStage.checklist : defaultStageChecklist
    ).map((n) => ({ id: n.id, title: n.title, phaseId: n.phaseId }));
    const parsedPhasesResult = await parsePhasesFromDocs(docs, parsedTasks, existingNodes);
    const importLimit = Number(url.searchParams.get('limit') || process.env.DOC_TASK_IMPORT_LIMIT || 8);
    const importCandidates = selectDailyDocTasks(parsedTasks, importLimit);

    // 去重：同 title + sourceDoc 不重复导入。默认只导入少量今日可领取任务，其余作为候选保留。
    let imported = 0;
    const nextStore = await updateStore((draft) => {
      const existing = draft.tasks || [];
      for (const t of importCandidates) {
        const dup = existing.find(
          (e) => e.title === t.title && e.sourceDoc === t.sourceDoc
        );
        if (!dup) {
          existing.unshift({
            id: createId('task'),
            title: t.title,
            owner: t.owner || '',
            priority: t.priority || 'P1',
            status: t.status || 'pending',
            description: t.description || '',
            dueDate: t.dueDate || '',
            sourceDoc: t.sourceDoc || '',
            projectId,
            acceptance: '',
            createdAt: new Date().toISOString()
          });
          imported++;
        }
      }
      draft.tasks = existing;
      // 缓存原始 docTasks 快照（用于进度追踪对照）
      if (!draft.docTasks) draft.docTasks = {};
      draft.docTasks[projectId] = parsedTasks;
      // 将 LLM 生成的阶段划分和节点写入 currentStage
      if (parsedPhasesResult?.phases?.length) {
        const { phases: newPhases, nodes: newNodes, nodeAssignments } = parsedPhasesResult;
        draft.currentStage = { ...(draft.currentStage || {}), phases: newPhases };
        if ((newNodes || []).length) {
          // LLM 返回了完整节点列表：以 LLM 为准，从旧节点补充证据字段
          const currentChecklist = draft.currentStage.checklist?.length
            ? draft.currentStage.checklist : defaultStageChecklist;
          const oldById = new Map(currentChecklist.map((n) => [n.id, n]));
          const newNodeSet = new Set(newNodes.map((n) => n.id));
          // 合并：LLM 节点 + 旧节点中有真实关联任务但不在 LLM 列表里的（保留证据）
          const mergedNodes = [
            ...newNodes.map((n) => {
              const old = oldById.get(n.id);
              return old ? { ...old, title: n.title || old.title, acceptance: n.acceptance || old.acceptance, phaseId: n.phaseId || old.phaseId } : n;
            }),
            ...currentChecklist.filter((n) => !newNodeSet.has(n.id) && (n.taskIds?.length > 0))
          ];
          draft.currentStage.checklist = reassignChecklistPhaseIds(mergedNodes, newPhases, nodeAssignments || {});
        }
      }
      return draft;
    });
    sendJson(res, 200, {
      imported,
      selected: importCandidates.length,
      totalCandidates: parsedTasks.length,
      importLimit: Math.min(Math.max(Number.isFinite(importLimit) ? Math.floor(importLimit) : 8, 1), 20),
      message: `已从 ${parsedTasks.length} 个候选任务中选择 ${importCandidates.length} 个适合近期领取的任务导入。`,
      importedTasks: nextStore.tasks.filter((t) => (
        t.projectId === projectId && importCandidates.some((candidate) => candidate.title === t.title && candidate.sourceDoc === t.sourceDoc)
      )),
      candidates: parsedTasks
    });
    return true;
  }

  // POST /api/projects/:id/update-docs — 将 hub 任务状态写回目标仓库 阶段进度追踪.md
  if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/update-docs')) {
    const projectId = url.pathname.split('/')[3];
    const store = await loadStore();
    const project = (store.projects || []).find((p) => p.id === projectId);
    if (!project) { sendError(res, 404, '项目不存在'); return true; }

    const { owner, repo } = project.githubFullRepo?.includes('/')
      ? { owner: project.githubFullRepo.split('/')[0], repo: project.githubFullRepo.split('/')[1] }
      : { owner: project.githubOwner || '', repo: project.repository || '' };

    if (!owner || !repo) { sendError(res, 400, '项目未配置 githubFullRepo'); return true; }

    const docTasks = (store.docTasks || {})[projectId] || [];
    const hubTasks = (store.tasks || []).filter((t) => t.projectId === projectId);
    const today = todayText();
    const todayAssignments = (store.assignments || []).filter((a) => a.date === today && a.projectId === projectId);

    const markdown = buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, today);
    await writeProgressToGitHub(owner, repo, markdown);

    sendJson(res, 200, { written: true, path: 'docs/阶段进度追踪.md', date: today });
    return true;
  }

  // POST /api/projects/:id/daily-scan — 全流程：同步 commits + sync-docs + update-docs
  if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/daily-scan')) {
    const projectId = url.pathname.split('/')[3];
    const store = await loadStore();
    const project = (store.projects || []).find((p) => p.id === projectId);
    if (!project) { sendError(res, 404, '项目不存在'); return true; }

    const result = { projectId, steps: {} };

    // Step 1: 同步 GitHub commits（复用已有逻辑）
    try {
      const { owner, repo } = project.githubFullRepo?.includes('/')
        ? { owner: project.githubFullRepo.split('/')[0], repo: project.githubFullRepo.split('/')[1] }
        : { owner: project.githubOwner || '', repo: project.repository || '' };

      if (owner && repo) {
        const syncResult = await scanGitHubProject(project, { maxCommits: 30 });
        if (syncResult) {
          await updateStore((draft) => {
            const newActivities = syncResult.activities || [];
            const retained = (draft.activities || []).filter((a) => !newActivities.find((n) => n.id === a.id));
            draft.activities = [...newActivities, ...retained].slice(0, 700);
            return draft;
          });
          result.steps.syncCommits = { ok: true, added: syncResult.activities?.length || 0 };
        }
      }
    } catch (err) {
      result.steps.syncCommits = { ok: false, error: err.message };
    }

    // Step 2: sync-docs（解析并导入任务）
    try {
      const freshStore = await loadStore();
      const { owner, repo } = project.githubFullRepo?.includes('/')
        ? { owner: project.githubFullRepo.split('/')[0], repo: project.githubFullRepo.split('/')[1] }
        : { owner: project.githubOwner || '', repo: project.repository || '' };
      const docs = await fetchProjectDocs(owner, repo);
      const parsedTasks = await parseDocsForTasks(docs);
      const snapForDailyScan = await loadStore();
      const existingNodesDailyScan = (snapForDailyScan.currentStage?.checklist?.length
        ? snapForDailyScan.currentStage.checklist : defaultStageChecklist
      ).map((n) => ({ id: n.id, title: n.title, phaseId: n.phaseId }));
      const parsedPhasesResult2 = await parsePhasesFromDocs(docs, parsedTasks, existingNodesDailyScan);
      const importLimit = Number(url.searchParams.get('limit') || process.env.DOC_TASK_IMPORT_LIMIT || 8);
      const importCandidates = selectDailyDocTasks(parsedTasks, importLimit);
      let imported = 0;
      await updateStore((draft) => {
        const existing = draft.tasks || [];
        for (const t of importCandidates) {
          if (!existing.find((e) => e.title === t.title && e.sourceDoc === t.sourceDoc)) {
            existing.unshift({ id: createId('task'), title: t.title, owner: t.owner || '', priority: t.priority || 'P1', status: t.status || 'pending', description: t.description || '', dueDate: t.dueDate || '', sourceDoc: t.sourceDoc || '', projectId, acceptance: '', createdAt: new Date().toISOString() });
            imported++;
          }
        }
        draft.tasks = existing;
        if (!draft.docTasks) draft.docTasks = {};
        draft.docTasks[projectId] = parsedTasks;
        if (parsedPhasesResult2?.phases?.length) {
          const { phases: newPhases2, nodes: newNodes2, nodeAssignments: na2 } = parsedPhasesResult2;
          draft.currentStage = { ...(draft.currentStage || {}), phases: newPhases2 };
          if ((newNodes2 || []).length) {
            const currentChecklist2 = draft.currentStage.checklist?.length
              ? draft.currentStage.checklist : defaultStageChecklist;
            const oldById2 = new Map(currentChecklist2.map((n) => [n.id, n]));
            const newNodeSet2 = new Set(newNodes2.map((n) => n.id));
            const mergedNodes2 = [
              ...newNodes2.map((n) => {
                const old2 = oldById2.get(n.id);
                return old2 ? { ...old2, title: n.title || old2.title, acceptance: n.acceptance || old2.acceptance, phaseId: n.phaseId || old2.phaseId } : n;
              }),
              ...currentChecklist2.filter((n) => !newNodeSet2.has(n.id) && (n.taskIds?.length > 0))
            ];
            draft.currentStage.checklist = reassignChecklistPhaseIds(mergedNodes2, newPhases2, na2 || {});
          }
        }
        return draft;
      });
      result.steps.syncDocs = { ok: true, imported, selected: importCandidates.length, totalCandidates: parsedTasks.length, phases: parsedPhasesResult2?.phases?.length || 0 };
    } catch (err) {
      result.steps.syncDocs = { ok: false, error: err.message };
    }

    // Step 3: update-docs（写回进度）
    try {
      const freshStore = await loadStore();
      const { owner, repo } = project.githubFullRepo?.includes('/')
        ? { owner: project.githubFullRepo.split('/')[0], repo: project.githubFullRepo.split('/')[1] }
        : { owner: project.githubOwner || '', repo: project.repository || '' };
      const docTasks = (freshStore.docTasks || {})[projectId] || [];
      const hubTasks = (freshStore.tasks || []).filter((t) => t.projectId === projectId);
      const today = todayText();
      const todayAssignments = (freshStore.assignments || []).filter((a) => a.date === today && a.projectId === projectId);
      const markdown = buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, today);
      await writeProgressToGitHub(owner, repo, markdown);
      result.steps.updateDocs = { ok: true };
    } catch (err) {
      result.steps.updateDocs = { ok: false, error: err.message };
    }

    sendJson(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const { json } = await readBody(req);
    if (!json || !json.title) {
      sendError(res, 400, 'title is required');
      return true;
    }

    const task = normalizeTask(json);
    const nextStore = await updateStore((store) => {
      store.tasks.unshift(task);
      return store;
    });
    sendJson(res, 201, { task, tasks: nextStore.tasks });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks/ai-progress') {
    const store = await loadStore();
    const results = await estimateTasksProgress(store);
    if (!results.length) {
      sendJson(res, 200, { tasks: store.tasks, suggestions: [], message: '无关联提交，无法估算进度。' });
      return true;
    }
    const next = await updateStore((draft) => {
      for (const r of results) {
        const task = draft.tasks.find((t) => t.id === r.taskId);
        if (!task) continue;
        const newProgress = Math.max(0, Math.min(100, Number(r.progress) || 0));
        task.progress = Math.max(task.progress || 0, newProgress);
        task.aiProgressSuggestion = {
          progress: newProgress,
          reason: String(r.reason || '').slice(0, 80),
          hint: String(r.hint || '').slice(0, 100),
          suggestComplete: !!r.suggestComplete,
          updatedAt: new Date().toISOString()
        };
      }
      return draft;
    });
    sendJson(res, 200, {
      tasks: next.tasks,
      suggestions: results.filter((r) => r.suggestComplete).map((r) => r.taskId)
    });
    return true;
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const { json } = await readBody(req);
    const nextStore = await updateStore((store) => {
      const index = store.tasks.findIndex((task) => task.id === id);
      if (index === -1) return store;
      store.tasks[index] = normalizeTask({ ...store.tasks[index], ...json, id, createdAt: store.tasks[index].createdAt });
      return store;
    });
    const task = nextStore.tasks.find((item) => item.id === id);
    if (!task) sendError(res, 404, 'task not found');
    else sendJson(res, 200, { task, tasks: nextStore.tasks });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/plans') {
    const { json } = await readBody(req);
    const store = await loadStore();
    const tasks = await generatePlan(json?.goal || '', store.members);
    sendJson(res, 200, {
      goal: json?.goal || '',
      tasks
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/plans/apply') {
    const { json } = await readBody(req);
    const plannedTasks = Array.isArray(json?.tasks) ? json.tasks : [];
    const normalized = plannedTasks.map((task) => normalizeTask(task));
    const nextStore = await updateStore((store) => {
      store.tasks = [...normalized, ...store.tasks];
      return store;
    });
    sendJson(res, 201, { tasks: nextStore.tasks, added: normalized.length });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/reviews') {
    const { json } = await readBody(req);
    const review = {
      id: createId('review'),
      humanDecision: null,
      ...await reviewChange(json || {})
    };
    const nextStore = await updateStore((store) => {
      store.reviews.unshift(review);
      return store;
    });
    sendJson(res, 201, { review, reviews: nextStore.reviews });
    return true;
  }

  // PATCH /api/reviews/:id — 人工审阅决策（acknowledged / needs-fix / exempted）
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/reviews/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const { json } = await readBody(req);
    const allowed = ['acknowledged', 'needs-fix', 'exempted'];
    const decision = allowed.includes(json?.humanDecision) ? json.humanDecision : null;
    let updated = null;
    const nextStore = await updateStore((draft) => {
      const idx = (draft.reviews || []).findIndex((r) => r.id === id);
      if (idx === -1) return draft;
      updated = {
        ...draft.reviews[idx],
        humanDecision: decision,
        humanNote: String(json?.humanNote || '').trim() || draft.reviews[idx].humanNote || '',
        humanAt: new Date().toISOString()
      };
      draft.reviews[idx] = updated;
      return draft;
    });
    if (!updated) { sendError(res, 404, 'review not found'); return true; }
    sendJson(res, 200, { review: updated });
    return true;
  }

  // GET /api/reviews/:id — 单条审阅详情（含 commit diff）
  if (req.method === 'GET' && url.pathname.match(/^\/api\/reviews\/[^/]+$/) && url.pathname !== '/api/reviews/queue') {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const store = await loadStore();
    const review = (store.reviews || []).find((r) => r.id === id);
    if (!review) { sendError(res, 404, 'review not found'); return true; }

    let diff = null;
    const sha = review.sha || (review.id.startsWith('review_') ? review.id.slice(7) : null);
    if (sha && review.repo) {
      const [repoOwner, repoName] = review.repo.split('/');
      if (repoOwner && repoName) {
        try {
          const detail = await fetchCommitDetail(repoOwner, repoName, sha);
          diff = (detail?.files || [])
            .slice(0, 10)
            .map((f) => `--- ${f.filename}\n${f.patch || '(binary or no patch)'}`)
            .join('\n\n');
        } catch { /* 无法获取 diff，静默跳过 */ }
      }
    }
    sendJson(res, 200, { review, diff });
    return true;
  }

  // POST /api/reviews/:id/solutions — AI 生成 2-3 个解决方案
  if (req.method === 'POST' && url.pathname.match(/^\/api\/reviews\/[^/]+\/solutions$/)) {
    const id = decodeURIComponent(url.pathname.split('/').slice(-2)[0]);
    const store = await loadStore();
    const review = (store.reviews || []).find((r) => r.id === id);
    if (!review) { sendError(res, 404, 'review not found'); return true; }

    if (review.solutions) {
      sendJson(res, 200, { solutions: review.solutions });
      return true;
    }

    const systemPrompt = `你是资深代码审阅专家。根据 AI 代码审阅的问题，给出 2-3 个具体可执行的解决方案。
每个方案必须包含：
- title: 方案标题（10字以内）
- detail: 具体操作步骤（50-100字）
- effort: 预计工作量（轻量/中等/较大）
- recommended: 是否为推荐方案（true/false，只能有一个true）

返回 JSON 数组格式。`;
    const userPrompt = `提交：${review.title}
作者：${review.owner}
审阅结论：${review.level}
AI 发现的问题：
${(review.findings || []).map((f, i) => `${i + 1}. ${f}`).join('\n')}
AI 建议：${review.suggestion || '无'}`;

    const raw = await callClaude(systemPrompt, userPrompt);
    const solutions = parseJsonOutput(raw);
    const finalSolutions = Array.isArray(solutions) ? solutions.slice(0, 3) : [
      { title: '立即修复', detail: '根据 AI 发现的问题逐项修复，提交新的 commit 并重新触发审阅。', effort: '中等', recommended: true },
      { title: '豁免处理', detail: '评估后认为该问题不影响生产，记录豁免理由并在下次迭代中优化。', effort: '轻量', recommended: false }
    ];

    await updateStore((draft) => {
      const idx = (draft.reviews || []).findIndex((r) => r.id === id);
      if (idx >= 0) draft.reviews[idx].solutions = finalSolutions;
      return draft;
    });

    sendJson(res, 200, { solutions: finalSolutions });
    return true;
  }

  // POST /api/reviews/:id/resolve — 最终决策（通过 or 选方案建任务）
  if (req.method === 'POST' && url.pathname.match(/^\/api\/reviews\/[^/]+\/resolve$/)) {
    const id = decodeURIComponent(url.pathname.split('/').slice(-2)[0]);
    const { json } = await readBody(req);
    const store = await loadStore();
    const review = (store.reviews || []).find((r) => r.id === id);
    if (!review) { sendError(res, 404, 'review not found'); return true; }

    const { decision, solution, solutionTitle, assignee } = json || {};
    if (!['pass', 'needs-fix'].includes(decision)) {
      sendError(res, 400, 'decision must be pass or needs-fix');
      return true;
    }

    let createdTask = null;
    if (decision === 'needs-fix' && solution) {
      // 继承被审阅 commit 的项目归属，确保出现在分工领取任务池中
      const reviewProject = review.repo ? review.repo : null;
      createdTask = {
        id: createId('task'),
        title: `[审阅修复] ${solutionTitle || review.title.slice(0, 30)}`,
        description: `来源：AI 代码审阅 ${review.shortSha || review.id}\n提交：${review.title}\n作者：${review.owner}\n\n选定方案：${solution}`,
        owner: assignee || review.owner || '未分配',
        status: '进行中',
        risk: review.level === 'Escalate' ? '高' : '中',
        progress: 0,
        reviewId: id,
        repo: reviewProject,
        projectId: 'cue_ai_classroom',
        createdAt: new Date().toISOString()
      };
    }

    let updatedReview;
    await updateStore((draft) => {
      const idx = (draft.reviews || []).findIndex((r) => r.id === id);
      if (idx >= 0) {
        updatedReview = {
          ...draft.reviews[idx],
          humanDecision: decision === 'pass' ? 'exempted' : 'needs-fix',
          humanNote: solution || '',
          humanAt: new Date().toISOString(),
          resolvedTaskId: createdTask?.id || null
        };
        draft.reviews[idx] = updatedReview;
      }
      if (createdTask) {
        draft.tasks = [createdTask, ...(draft.tasks || [])];
      }
      return draft;
    });

    sendJson(res, 200, { review: updatedReview, task: createdTask });
    return true;
  }

  // GET /api/reviews/queue — 人工待办：Block+Escalate 未处理 + 最近无决策的 commit review
  if (req.method === 'GET' && url.pathname === '/api/reviews/queue') {
    const store = await loadStore();
    const allReviews = store.reviews || [];
    // Block/Escalate 且未做过人工决策
    const pending = allReviews.filter(
      (r) => (r.level === 'Block' || r.level === 'Escalate') && !r.humanDecision
    );
    // 所有未决 Warning 都保留到人工处理，不因页面刷新或时间窗口消失
    const recent = allReviews.filter((r) => {
      if (r.humanDecision) return false;
      if (r.level === 'Block' || r.level === 'Escalate') return false; // already in pending
      if (r.level === 'Pass') return false;
      return true;
    });
    const queue = [
      ...pending.sort((a, b) => (b.level === 'Block') - (a.level === 'Block')),
      ...recent.slice(0, 30)
    ];
    sendJson(res, 200, {
      queue,
      pendingCount: pending.length,
      recentCount: recent.length,
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/risks/scan') {
    const store = await loadStore();
    const alerts = scanRisks(store);
    const nextStore = await saveStore({ ...store, alerts });
    sendJson(res, 200, { alerts, metrics: buildMetrics(nextStore, alerts) });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/reports/evening') {
    const store = await loadStore();
    const date = getDateParam(url);
    const entry = (store.eveningReports || {})[date];
    if (!entry) {
      sendJson(res, 200, { date, report: null, error: '该日暂无晚报记录' });
    } else {
      sendJson(res, 200, { date, ...entry });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/reports/evening') {
    const { json } = await readBody(req);
    const date = json?.date || todayText();
    // generateEveningReport 内部完成：规则引擎 + LLM + 快照持久化 + WeCom 推送
    const finalEntry = await generateEveningReport(date);
    // 重新读取已更新的 store 以返回最新 tasks/currentStage/alerts
    const updatedStore = await loadStore();
    const alerts = updatedStore.alerts || [];
    sendJson(res, 201, {
      date,
      report: finalEntry,
      wecomSent: isWeComAvailable(),
      tasks: updatedStore.tasks,
      currentStage: updatedStore.currentStage,
      alerts,
      metrics: buildMetrics(updatedStore, alerts)
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/webhooks/github') {
    const { raw, json } = await readBody(req);
    if (!json) {
      sendError(res, 400, 'invalid json payload');
      return true;
    }

    const signature = req.headers['x-hub-signature-256'];
    if (!verifyGitHubSignature(raw, signature, githubWebhookSecret)) {
      sendError(res, 401, 'invalid github signature');
      return true;
    }

    const eventName = req.headers['x-github-event'] || 'unknown';
    const activities = parseGitHubEvent(eventName, json);
    const reviews = [];

    for (const activity of activities) {
      if (activity.type === 'pull_request') {
        reviews.push({
          id: createId('review'),
          ...await reviewChange({
            repo: activity.repo,
            title: activity.title,
            owner: activity.actor,
            diff: `${activity.action || ''} ${activity.branch || ''}`,
            files: activity.files
          })
        });
      }
    }

    const nextStore = await updateStore((store) => {
      store.activities = [...activities, ...(store.activities || [])].slice(0, 500);
      store.reviews = [...reviews, ...(store.reviews || [])].slice(0, 200);
      return store;
    });

    // 异步生成计划调整建议（不阻塞响应）
    if (activities.length > 0) {
      generatePlanAdjustment(activities, nextStore).then((adjustment) => {
        if (!adjustment) return null;
        return persistPlanAdjustment(adjustment, activities, 'github-webhook');
      }).catch((err) => console.error('[PlanAdjust]', err.message));
    }

    sendJson(res, 202, {
      received: true,
      event: eventName,
      activities,
      reviews,
      metrics: buildMetrics(nextStore, scanRisks(nextStore))
    });
    return true;
  }

  // DELETE /api/tasks/:id — 删除任务
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/tasks/')) {
    const id = decodeURIComponent(url.pathname.split('/')[3] || '');
    const nextStore = await updateStore((store) => {
      store.tasks = store.tasks.filter((task) => task.id !== id);
      return store;
    });
    sendJson(res, 200, { deleted: id, tasks: nextStore.tasks });
    return true;
  }

  // GET /api/standups?date=YYYY-MM-DD — 获取某日站会记录
  if (req.method === 'GET' && url.pathname === '/api/standups') {
    const store = await loadStore();
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const standups = (store.standups || []).filter((s) => s.date === date);
    sendJson(res, 200, { date, standups });
    return true;
  }

  // POST /api/standups — 提交站会
  if (req.method === 'POST' && url.pathname === '/api/standups') {
    const { json } = await readBody(req);
    if (!json?.owner) { sendError(res, 400, '缺少 owner 字段'); return true; }
    const today = new Date().toISOString().slice(0, 10);
    const standup = {
      id: createId('standup'),
      date: today,
      owner: String(json.owner).trim(),
      yesterday: String(json.yesterday || '').trim(),
      today: String(json.today || '').trim(),
      blockers: String(json.blockers || '').trim(),
      isLeave: Boolean(json.isLeave),
      proxy: String(json.proxy || '').trim(),
      createdAt: new Date().toISOString()
    };
    const nextStore = await updateStore((store) => {
      // 同一人同一天只保留最新一条
      store.standups = (store.standups || []).filter(
        (s) => !(s.owner === standup.owner && s.date === standup.date)
      );
      store.standups.unshift(standup);
      store.standups = store.standups.slice(0, 500);
      return store;
    });
    const todayStandups = (nextStore.standups || []).filter((s) => s.date === today);
    sendJson(res, 201, { standup, count: todayStandups.length });
    return true;
  }

  // POST /api/standups/summarize — LLM 汇总当日站会
  if (req.method === 'POST' && url.pathname === '/api/standups/summarize') {
    const store = await loadStore();
    const today = new Date().toISOString().slice(0, 10);
    const todayStandups = (store.standups || []).filter((s) => s.date === today);
    if (!todayStandups.length) {
      sendJson(res, 200, { date: today, summary: '今日暂无站会记录。', standups: [] });
      return true;
    }

    const STANDUP_SYSTEM_PROMPT = `你是 CUE Project Hub 的异步站会 AI 主持人。
根据团队成员提交的站会记录，生成一份简洁的中文日站总结，格式要求：
1. 开头一句话概括整体状态（人数、阻塞数量）
2. 按成员列出：昨日完成、今日计划、阻塞项（如有）
3. 单独列出请假成员和交接人
4. 末尾列出需要管理者关注的阻塞项（如有）
输出纯文本 Markdown，不需要 JSON。`;

    const userPrompt = `今天是 ${today}，以下是各成员的站会回复：\n\n${todayStandups.map((s) => `**${s.owner}**${s.isLeave ? '（请假，交接人：' + (s.proxy || '未指定') + '）' : ''}
- 昨日：${s.yesterday || '未填写'}
- 今日：${s.today || '未填写'}
- 阻塞：${s.blockers || '无'}`).join('\n\n')}`;

    const summary = await callClaude(STANDUP_SYSTEM_PROMPT, userPrompt) ||
      todayStandups.map((s) => `${s.owner}：${s.today || '未填写今日计划'}`).join('；');

    // 保存汇总到 store
    await updateStore((draft) => {
      draft.standupSummaries = draft.standupSummaries || {};
      draft.standupSummaries[today] = { summary, generatedAt: new Date().toISOString() };
      return draft;
    });

    // 推送到企业微信
    if (isWeComAvailable()) {
      await sendWeComMarkdown(`# 📋 ${today} 站会汇总\n\n${summary}`);
    }

    sendJson(res, 200, { date: today, summary, standups: todayStandups });
    return true;
  }

  // POST /api/reports/daily — LLM 生成日报
  if (req.method === 'POST' && url.pathname === '/api/reports/daily') {
    const store = await loadStore();
    const today = new Date().toISOString().slice(0, 10);
    const alerts = scanRisks(store);
    const metrics = buildMetrics(store, alerts);
    const todayStandups = (store.standups || []).filter((s) => s.date === today);
    const recentReviews = (store.reviews || []).slice(0, 10);
    const activeTasks = (store.tasks || []).filter((t) => t.status !== '已完成');

    const REPORT_SYSTEM_PROMPT = `你是 CUE Project Hub 的 AI 报告生成器，专为技术负责人和产品负责人生成简洁的研发日报。
报告结构（Markdown 格式）：
1. **今日交付概况**：健康度评分、核心指标（风险任务/待审阅/告警数）
2. **任务进展**：列出进行中和高风险任务的状态
3. **代码审阅摘要**：今日 Review 结论（阻断/警告数量）
4. **站会要点**：团队动态、阻塞项（如有站会数据）
5. **风险与行动项**：P1/P2 告警，建议行动
报告要简洁专业，用中文，总长不超过 600 字。`;

    const userPrompt = `生成 ${today} 的研发日报。

数据如下：
健康度：${metrics.healthScore ?? 0} 分
高风险任务：${metrics.highRiskTasks ?? 0} 个
待审阅：${metrics.pendingReviews ?? 0} 个
紧急告警：${metrics.urgentAlerts ?? 0} 个

进行中任务（前10条）：
${activeTasks.slice(0, 10).map((t) => `- [${t.status}] ${t.title}（${t.owner}）进度 ${t.progress}% 风险:${t.risk}`).join('\n')}

最近 AI Review：
${recentReviews.map((r) => `- ${r.level} | ${r.title}（${r.owner}）分数:${r.score}`).join('\n')}

今日站会（${todayStandups.length} 人回复）：
${todayStandups.length ? todayStandups.map((s) => `- ${s.owner}：${s.blockers ? '⚠️ 阻塞：' + s.blockers : '无阻塞'}`).join('\n') : '暂无站会记录'}

P1 告警：
${alerts.filter((a) => a.severity === 'P1').map((a) => `- ${a.title}：${a.detail}`).join('\n') || '无'}`;

    const report = await callClaude(REPORT_SYSTEM_PROMPT, userPrompt) ||
      `# ${today} 研发日报\n\n健康度：${metrics.healthScore ?? 0} 分\n高风险任务：${metrics.highRiskTasks ?? 0} 个\n\n（LLM 生成失败，显示基础数据）`;

    // 保存报告
    await updateStore((draft) => {
      draft.reports = draft.reports || {};
      draft.reports[today] = { report, generatedAt: new Date().toISOString() };
      return draft;
    });

    // 推送到企业微信
    let wecomSent = false;
    if (isWeComAvailable()) {
      wecomSent = await pushReport(`# 📊 ${today} 研发日报\n\n${report}`);
    }

    sendJson(res, 200, { date: today, report, wecomSent });
    return true;
  }

  // POST /api/wecom/push — 手动推送消息到企业微信
  if (req.method === 'POST' && url.pathname === '/api/wecom/push') {
    if (!isWeComAvailable()) {
      sendError(res, 400, '未配置 WECOM_WEBHOOK_URL');
      return true;
    }
    const { json } = await readBody(req);
    const content = String(json?.content || '').trim();
    if (!content) { sendError(res, 400, '缺少 content 字段'); return true; }
    const ok = await sendWeComMarkdown(content);
    sendJson(res, 200, { sent: ok });
    return true;
  }

  // GET /api/wecom/summary — 企业微信 API 插件友好的项目摘要
  if (req.method === 'GET' && url.pathname === '/api/wecom/summary') {
    const store = await loadStore();
    const alerts = scanRisks(store);
    sendJson(res, 200, {
      summary: buildWeComProjectSummary(store, alerts),
      metrics: buildMetrics(store, alerts),
      alertCount: alerts.length,
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  // GET /api/wecom/risks — 企业微信 API 插件友好的风险摘要
  if (req.method === 'GET' && url.pathname === '/api/wecom/risks') {
    const store = await loadStore();
    const alerts = scanRisks(store);
    sendJson(res, 200, {
      summary: buildWeComRiskSummary(store, alerts),
      metrics: buildMetrics(store, alerts),
      alertCount: alerts.length,
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  // GET /api/wecom/tasks — 企微插件：返回当前可认领任务列表
  if (req.method === 'GET' && url.pathname === '/api/wecom/tasks') {
    const store = await loadStore();
    const today = todayText();
    const claimedToday = new Set((store.assignments || []).filter((a) => a.date === today).map((a) => a.taskId));
    const active = (store.tasks || [])
      .filter((t) => t.status !== '已完成')
      .slice(0, 12)
      .map((t) => ({
        id: t.id,
        title: t.title,
        owner: t.owner || '未分配',
        progress: t.progress || 0,
        risk: t.risk || '低',
        due: t.due || '未设置',
        claimedToday: claimedToday.has(t.id)
      }));
    const lines = active.map((t, i) =>
      `${i + 1}. 【${t.risk}风险】${t.title}（${t.owner} · ${t.progress}% · 截止${t.due}）${t.claimedToday ? ' ✅已认领' : ''}`
    ).join('\n');
    const summary = active.length ? `当前 ${active.length} 个进行中任务：\n${lines}` : '暂无进行中任务。';
    sendJson(res, 200, {
      summary,
      result: summary,
      tasks: active
    });
    return true;
  }

  // POST /api/wecom/claim — 企微插件：按关键词认领任务
  if (req.method === 'POST' && url.pathname === '/api/wecom/claim') {
    const { json } = await readBody(req);
    const owner = String(json?.owner || '').trim();
    const keyword = String(json?.taskKeyword || json?.taskTitle || json?.keyword || '').trim();
    if (!owner || !keyword) {
      sendJson(res, 200, { result: '❌ 请提供认领人姓名和任务关键词，例如：owner=田家铭 taskKeyword=TRTC' });
      return true;
    }
    const store = await loadStore();
    const kw = keyword.toLowerCase();
    const task = (store.tasks || []).find((t) =>
      t.status !== '已完成' && t.title.toLowerCase().includes(kw)
    );
    if (!task) {
      const candidates = (store.tasks || []).filter((t) => t.status !== '已完成').slice(0, 5)
        .map((t) => `「${t.title}」`).join('、');
      sendJson(res, 200, { result: `❌ 未找到包含「${keyword}」的进行中任务。当前可认领：${candidates || '暂无'}` });
      return true;
    }
    const today = todayText();
    const already = (store.assignments || []).find(
      (a) => a.owner === owner && a.taskId === task.id && a.date === today
    );
    if (already) {
      sendJson(res, 200, { result: `ℹ️ ${owner} 今日已认领「${task.title}」，无需重复认领。` });
      return true;
    }
    const assignment = {
      id: createId('assign'),
      date: today,
      owner,
      taskId: task.id,
      taskTitle: task.title,
      note: '',
      status: '进行中',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await updateStore((draft) => {
      draft.assignments = (draft.assignments || []).filter(
        (a) => !(a.owner === owner && a.taskId === task.id && a.date === today)
      );
      draft.assignments.unshift(assignment);
      return draft;
    });
    // 异步生成 brief
    generateAssignmentBrief({ task, owner, note: '', store })
      .then((brief) => updateStore((draft) => {
        const idx = (draft.assignments || []).findIndex((a) => a.id === assignment.id);
        if (idx >= 0) { draft.assignments[idx].brief = brief; draft.assignments[idx].briefGeneratedBy = brief.generatedBy; }
        return draft;
      }))
      .catch((err) => console.error('[Brief/WeComClaim]', err.message));
    sendJson(res, 200, { result: `✅ ${owner} 已认领「${task.title}」，任务细则正在生成，稍后可在 Hub 查看。` });
    return true;
  }

  // POST /api/wecom/standup — 企微插件：提交今日站会
  if (req.method === 'POST' && url.pathname === '/api/wecom/standup') {
    const { json } = await readBody(req);
    const owner = String(json?.owner || '').trim();
    if (!owner) {
      sendJson(res, 200, { result: '❌ 请提供成员姓名（owner 字段）' });
      return true;
    }
    const standup = normalizeStandup({
      owner,
      yesterday: String(json?.yesterday || '').trim(),
      today: String(json?.today || '').trim(),
      blockers: String(json?.blockers || '无').trim()
    });
    await updateStore((draft) => {
      draft.standups = (draft.standups || []).filter(
        (s) => !(s.owner === owner && s.date === standup.date)
      );
      draft.standups.unshift(standup);
      draft.standups = draft.standups.slice(0, 500);
      return draft;
    });
    const blockerLine = standup.blockers && standup.blockers !== '无' ? `\n⚠️ 阻塞：${standup.blockers}` : '';
    sendJson(res, 200, { result: `✅ ${owner} 站会已提交（${standup.date}）\n昨日：${standup.yesterday || '未填写'}\n今日：${standup.today || '未填写'}${blockerLine}` });
    return true;
  }

  // POST /api/wecom/progress — 企微插件：按关键词更新任务进度
  if (req.method === 'POST' && url.pathname === '/api/wecom/progress') {
    const { json } = await readBody(req);
    const keyword = String(json?.taskKeyword || json?.taskTitle || '').trim();
    const progress = Number(json?.progress ?? -1);
    const status = String(json?.status || '').trim();
    if (!keyword || (progress < 0 && !status)) {
      sendJson(res, 200, { result: '❌ 请提供任务关键词（taskKeyword）和进度（progress 0-100）或状态（status）' });
      return true;
    }
    const store = await loadStore();
    const kw = keyword.toLowerCase();
    const task = (store.tasks || []).find((t) => t.title.toLowerCase().includes(kw));
    if (!task) {
      sendJson(res, 200, { result: `❌ 未找到包含「${keyword}」的任务` });
      return true;
    }
    const newProgress = progress >= 0 && progress <= 100 ? progress : task.progress;
    const newStatus = status || task.status;
    await updateStore((draft) => {
      const idx = (draft.tasks || []).findIndex((t) => t.id === task.id);
      if (idx >= 0) {
        draft.tasks[idx] = normalizeTask({
          ...draft.tasks[idx],
          progress: newProgress,
          status: newStatus
        });
      }
      return draft;
    });
    const parts = [];
    if (progress >= 0 && progress <= 100) parts.push(`进度 → ${newProgress}%`);
    if (status) parts.push(`状态 → ${newStatus}`);
    sendJson(res, 200, { result: `✅ 已更新「${task.title}」：${parts.join('，')}` });
    return true;
  }

  // GET /api/config — 返回前端需要的功能开关（不含密钥）
  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, {
      githubEnabled: Boolean(process.env.GITHUB_TOKEN),
      apiKeyRequiredForWrites: Boolean(cueApiKey),
      wecomEnabled: isWeComAvailable(),
      llmEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
      meetingHour,
      hubUrl
    });
    return true;
  }

  // ─── 任务领取/分工系统 ────────────────────────────────────────────────────────

  // GET /api/assignments?date=YYYY-MM-DD
  if (req.method === 'GET' && url.pathname === '/api/assignments') {
    const store = await loadStore();
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const assignments = (store.assignments || []).filter((a) => a.date === date);
    sendJson(res, 200, { date, assignments });
    return true;
  }

  // POST /api/assignments — 领取任务（此路由已由上方早期路由处理，此处为冗余定义，保留作降级）

  // PATCH /api/assignments/:id — 更新领取状态
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/assignments/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const { json } = await readBody(req);
    const now = new Date().toISOString();
    const nextStore = await updateStore((draft) => {
      const index = (draft.assignments || []).findIndex((a) => a.id === id);
      if (index === -1) return draft;
      draft.assignments[index] = {
        ...draft.assignments[index],
        ...(json.status !== undefined ? { status: json.status } : {}),
        ...(json.note !== undefined ? { note: json.note } : {}),
        updatedAt: now
      };
      return draft;
    });
    const assignment = (nextStore.assignments || []).find((a) => a.id === id);
    if (!assignment) { sendError(res, 404, 'assignment not found'); return true; }
    sendJson(res, 200, { assignment });
    return true;
  }

  // DELETE /api/assignments/:id — 取消领取
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/assignments/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const nextStore = await updateStore((draft) => {
      draft.assignments = (draft.assignments || []).filter((a) => a.id !== id);
      return draft;
    });
    sendJson(res, 200, { deleted: id, assignments: nextStore.assignments || [] });
    return true;
  }

  // ─── 晚报分工 vs commits 对照总结 ─────────────────────────────────────────────

  // GET /api/reports/compare?date=YYYY-MM-DD
  if (req.method === 'GET' && url.pathname === '/api/reports/compare') {
    const store = await loadStore();
    const date = url.searchParams.get('date') || todayText();
    const eveningEntry = (store.eveningReports || {})[date];
    if (!eveningEntry) {
      sendJson(res, 200, { date, error: '该日无晚报记录，请先生成晚报' });
      return true;
    }

    // 使用晚报快照中的分工和提交记录，而非实时数据
    const snapshotAssignments = eveningEntry.assignments || [];
    const snapshotCommits = eveningEntry.commits || [];

    const COMPARE_SYSTEM = `你是 CUE Project Hub 的对照分析 AI。根据当日晚报中记录的任务分工快照和实际 GitHub commit 记录，生成对照分析报告（Markdown）。
对每个分工领取：判断是否有对应的 commit（通过提交者姓名匹配）。
输出格式：
1. **完成情况总览**：X 人领取，Y 人有 commit 支撑，Z 人无 commit 记录
2. **逐条对照**：每个分工 → 完成 ✅ / 遗漏 ⚠️
3. **结论**：需要跟进的成员和任务`;

    const assignmentLines = snapshotAssignments.length
      ? snapshotAssignments.map((a) => `- ${a.owner} 领取「${a.taskTitle}」状态:${a.status}`).join('\n')
      : '无分工记录';
    const commitLines = snapshotCommits.length
      ? snapshotCommits.map((c) => `- ${c.owner || c.actor || '未知'}: ${c.title}`).join('\n')
      : '无 commit 记录（晚报快照时刻）';

    const comparison = await callClaude(
      COMPARE_SYSTEM,
      `${date} 晚报分工快照：\n${assignmentLines}\n\n快照时刻 commit 记录：\n${commitLines}`
    ) || `# ${date} 对照分析\n\n分工：${snapshotAssignments.length} 条，提交：${snapshotCommits.length} 条\n\n（LLM 生成失败）`;

    sendJson(res, 200, { date, comparison, assignments: snapshotAssignments, commits: snapshotCommits });
    return true;
  }

  // ─── 计划调整建议 ─────────────────────────────────────────────────────────────

  // GET /api/plan-adjustments — 获取最近计划调整建议列表（最多20条）
  if (req.method === 'GET' && url.pathname === '/api/plan-adjustments') {
    const store = await loadStore();
    const adjustments = (store.planAdjustments || []).slice(0, 20);
    sendJson(res, 200, { adjustments });
    return true;
  }

  // POST /api/plan-adjustments/:id/alternatives — 懒加载备选方案
  if (req.method === 'POST' && url.pathname.startsWith('/api/plan-adjustments/') && url.pathname.endsWith('/alternatives')) {
    const id = decodeURIComponent(url.pathname.split('/')[3] || '');
    const store = await loadStore();
    const item = (store.planAdjustments || []).find((a) => a.id === id);
    if (!item) { sendError(res, 404, 'not found'); return true; }
    if (item.alternatives?.length) {
      sendJson(res, 200, { alternatives: item.alternatives });
      return true;
    }
    const alternatives = await generatePlanAlternatives(item);
    await updateStore((draft) => {
      const idx = (draft.planAdjustments || []).findIndex((a) => a.id === id);
      if (idx >= 0) draft.planAdjustments[idx].alternatives = alternatives;
      return draft;
    });
    sendJson(res, 200, { alternatives });
    return true;
  }

  // POST /api/plan-adjustments/:id/decision — 人工审批大的开发计划调整
  if (req.method === 'POST' && url.pathname.startsWith('/api/plan-adjustments/') && url.pathname.endsWith('/decision')) {
    const id = decodeURIComponent(url.pathname.split('/')[3] || '');
    const { json } = await readBody(req);
    const decision = String(json?.decision || '').trim();
    if (!['approved', 'rejected'].includes(decision)) {
      sendError(res, 400, 'decision must be approved or rejected');
      return true;
    }
    const decidedAt = new Date().toISOString();
    const nextStore = await updateStore((draft) => {
      const index = (draft.planAdjustments || []).findIndex((item) => item.id === id);
      if (index < 0) return draft;
      // 若传入 selectedAlternative，用其 stageUpdate 覆盖主方案
      const base = draft.planAdjustments[index];
      const alt = json?.selectedAlternative;
      const nextAdjustment = {
        ...base,
        status: decision,
        decidedAt,
        decisionNote: String(json?.note || '').trim(),
        selectedAlternativeTitle: alt?.title || null,
        stageUpdate: (decision === 'approved' && alt?.stageUpdate) ? normalizePlanStageUpdate(alt.stageUpdate, 'major') : base.stageUpdate,
        appliedAt: decision === 'approved' && (alt?.stageUpdate || base.stageUpdate) ? decidedAt : base.appliedAt
      };
      let nextDraft = draft;
      if (decision === 'approved') {
        nextDraft = applyPlanAdjustmentToStage(draft, nextAdjustment);
      }
      nextDraft.planAdjustments[index] = nextAdjustment;
      return nextDraft;
    });
    const adjustment = (nextStore.planAdjustments || []).find((item) => item.id === id);
    if (!adjustment) {
      sendError(res, 404, 'plan adjustment not found');
      return true;
    }
    sendJson(res, 200, { adjustment, adjustments: nextStore.planAdjustments || [] });
    return true;
  }

  // ─── 晚会后总结 ───────────────────────────────────────────────────────────────

  // POST /api/reports/meeting-summary — 晚会结束后手动触发，总结今日分工并推企微
  if (req.method === 'POST' && url.pathname === '/api/reports/meeting-summary') {
    const { json } = await readBody(req);
    const date = json?.date || todayText();
    const store = await loadStore();

    const todayAssignments = (store.assignments || []).filter((a) => a.date === date);
    const eveningEntry = (store.eveningReports || {})[date];
    const nextTargets = eveningEntry?.nextTargets || [];

    // LLM 生成会后总结（含分工+明日重点+待跟进，不超过 300 字，企微友好）
    const SUMMARY_SYSTEM = `你是 CUE Project Hub 的晚会总结 AI。根据今日晚会的分工领取情况，生成简洁的会后总结。
格式（纯 Markdown 列表，无表格，总长不超过 300 字）：
## 今日分工
- 成员名 → 「任务标题」
（逐条列出，每人一行）
## 明日重点
（2-3 条最重要的技术目标）
## 待跟进
（有风险或未领取的，无则省略）
要求：语言简洁，适合企业微信群消息。`;

    const assignmentLines = todayAssignments.length
      ? todayAssignments.map((a) => `- ${a.owner} → 「${a.taskTitle}」（${a.status}）`).join('\n')
      : '今日暂无分工记录';
    const targetLines = nextTargets.slice(0, 6)
      .map((t) => `- ${t.priority} ${t.owner}：${t.taskTitle}`).join('\n') || '';

    const summaryText = await callClaude(
      SUMMARY_SYSTEM,
      `${date} 晚会分工（共 ${todayAssignments.length} 条）：\n${assignmentLines}${
        targetLines ? `\n\n晚报建议关注：\n${targetLines}` : ''
      }`
    );

    // 存储会后总结
    await updateStore((draft) => {
      draft.reports = draft.reports || {};
      draft.reports[date] = {
        ...(draft.reports[date] || {}),
        meetingSummary: summaryText || '',
        meetingSummaryAt: new Date().toISOString()
      };
      return draft;
    });

    // 推送企微：使用 WeCom 格式化函数
    let wecomSent = false;
    if (isWeComAvailable()) {
      const wecomMsg = buildMeetingSummaryWeComMsg(date, todayAssignments, summaryText || '', hubUrl);
      wecomSent = await sendWeComMarkdown(wecomMsg).catch((err) => {
        console.error('[WeCom] 会后总结推送失败:', err.message);
        return false;
      });
    }

    sendJson(res, 200, {
      date,
      summary: summaryText || '',
      assignmentCount: todayAssignments.length,
      wecomSent
    });
    return true;
  }

  // GET /api/reports/meeting-summary?date=YYYY-MM-DD — 获取指定日期会后总结
  if (req.method === 'GET' && url.pathname === '/api/reports/meeting-summary') {
    const store = await loadStore();
    const date = url.searchParams.get('date') || todayText();
    const dayReport = (store.reports || {})[date] || {};
    sendJson(res, 200, {
      date,
      summary: dayReport.meetingSummary || null,
      generatedAt: dayReport.meetingSummaryAt || null
    });
    return true;
  }

  return false;
}

async function serveStatic(res, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(rootDir, safePath);

  if (!filePath.startsWith(rootDir)) {
    sendError(res, 403, 'forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': contentTypes[extname(filePath)] || 'application/octet-stream'
    });
    res.end(data);
  } catch {
    sendError(res, 404, 'not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      // 处理 CORS 预检请求
      if (req.method === 'OPTIONS') {
        setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (requiresApiKey(req, url) && !hasValidApiKey(req)) {
        sendError(res, 401, 'invalid api key', '写入或触发动作的 API 需要请求头 X-CUE-API-Key。');
        return;
      }

      const handled = await handleApi(req, res, url);
      if (!handled) sendError(res, 404, 'api route not found');
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendError(res, 500, 'internal server error', error.message);
  }
});

// ─── 每日晚会前 15 分钟自动生成作战包并推送企业微信 ─────────────────────────
// 晚会时间由 MEETING_HOUR 控制（默认 18），作战包在 MEETING_HOUR:45 推送
// 例如：MEETING_HOUR=18 → 每天 17:45 自动生成并推送到企微
function startScheduler() {
  let lastEveningReportDate = '';
  let lastReviewQueueDate = '';
  let githubSyncRunning = false;
  const prepHour = meetingHour === 0 ? 23 : meetingHour - 1; // 前一小时
  const prepMinute = 45;
  // 晚会前 2h 推送人工审阅待办提醒
  const reviewHour = meetingHour <= 1 ? meetingHour + 22 : meetingHour - 2;

  async function syncGitHubProjects() {
    if (githubSyncIntervalMinutes <= 0 || githubSyncRunning) return;
    githubSyncRunning = true;
    try {
      const store = await loadStore();
      const projects = (store.projects || []).filter((project) => hasGitHubConfig(project));
      for (const project of projects) {
        try {
          const result = await syncGitHubProjectIntoStore(project, {
            since: '7 days ago',
            limit: githubSyncLimit,
            diffLimit: githubSyncDiffLimit
          });
          if (result.addedActivities || result.addedReviews) {
            console.log(`[Scheduler] GitHub 已同步 ${project.githubFullRepo || project.repository}：新增 ${result.addedActivities} 条提交，新增 ${result.addedReviews} 条 Review`);
          }
        } catch (err) {
          console.error(`[Scheduler] GitHub 同步失败 ${project.githubFullRepo || project.repository || project.id}:`, err.message);
        }
      }
    } finally {
      githubSyncRunning = false;
    }
  }

  if (githubSyncIntervalMinutes > 0) {
    setTimeout(syncGitHubProjects, 15_000);
    setInterval(syncGitHubProjects, githubSyncIntervalMinutes * 60_000);
  }

  setInterval(async () => {
    // 使用 Asia/Shanghai 时区，避免服务器时区偏差
    const now = new Date();
    const shanghaiParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).formatToParts(now);
    const sh = Number(shanghaiParts.find((p) => p.type === 'hour')?.value ?? -1);
    const sm = Number(shanghaiParts.find((p) => p.type === 'minute')?.value ?? -1);
    const today = todayText();

    if (sh === prepHour && sm === prepMinute && lastEveningReportDate !== today) {
      lastEveningReportDate = today;
      console.log(`[Scheduler] ${prepHour}:${String(prepMinute).padStart(2,'0')} 触发晚会前作战包生成...`);
      await generateEveningReport(today).catch((err) =>
        console.error('[Scheduler] 作战包生成失败:', err.message)
      );
    }

    // 晚会前 2h（reviewHour:00）推送人工审阅待办提醒
    if (sh === reviewHour && sm === 0 && lastReviewQueueDate !== today) {
      lastReviewQueueDate = today;
      if (isWeComAvailable()) {
        const store = await loadStore();
        const allReviews = store.reviews || [];
        const pending = allReviews.filter(
          (r) => (r.level === 'Block' || r.level === 'Escalate') && !r.humanDecision
        );
        const cutoff = Date.now() - 48 * 3600 * 1000;
        const warning = allReviews.filter((r) => {
          if (r.humanDecision || r.level === 'Block' || r.level === 'Escalate' || r.level === 'Pass') return false;
          return new Date(r.createdAt || 0).getTime() >= cutoff;
        });
        if (pending.length || warning.length) {
          const lines = [
            `## 📋 人工审阅提醒（晚会前 ${meetingHour - reviewHour}h）`,
            '',
            pending.length
              ? `**Block/Escalate 待处理（${pending.length} 条）：**\n${pending.slice(0, 5).map((r) => `- [${r.level}] ${r.owner || '未知'}：${r.title}`).join('\n')}`
              : '✅ 无 Block/Escalate 阻断项',
            '',
            warning.length
              ? `**近 48h Warning 待确认（${warning.length} 条）：**\n${warning.slice(0, 5).map((r) => `- ${r.owner || '未知'}：${r.title}`).join('\n')}`
              : '',
            '',
            `[前往人工审阅](${hubUrl}#reviews)`
          ].filter((l) => l !== undefined).join('\n');
          await sendWeComMarkdown(lines).catch((err) =>
            console.error('[Scheduler] 人工审阅提醒推送失败:', err.message)
          );
          console.log(`[Scheduler] ${reviewHour}:00 已推送人工审阅提醒（${pending.length} Block/Escalate，${warning.length} Warning）`);
        }
      }
    }
  }, 60_000);
}

startScheduler();

// 启动后异步检查并修正脏 phases/checklist（phase_doc_N 或节点 phaseId 失配）
setTimeout(async () => {
  try {
    const s = await loadStore();
    const phases = s.currentStage?.phases || [];
    const checklist = s.currentStage?.checklist || [];
    const phaseIdSet = new Set(phases.map((p) => p.id));
    const hasDocPhases = phases.length > 0 && phases.every((p) => /^phase_doc_/.test(p.id));
    const hasMissingPhaseId = checklist.some((n) => !phaseIdSet.has(n.phaseId));
    if (!hasDocPhases && !hasMissingPhaseId) return;
    console.log('[Startup] 检测到 phases 需要修正，触发异步 LLM 重新分配...');
    const project = (s.projects || []).find((p) => p.githubFullRepo?.includes('/'));
    if (!project) return;
    const { owner, repo } = project.githubFullRepo.split('/').length >= 2
      ? { owner: project.githubFullRepo.split('/')[0], repo: project.githubFullRepo.split('/')[1] }
      : { owner: '', repo: '' };
    if (!owner || !repo) return;
    const docs = await fetchProjectDocs(owner, repo);
    if (!docs.length) return;
    const existingNodesStartup = checklist.map((n) => ({ id: n.id, title: n.title, phaseId: n.phaseId }));
    const result = await parsePhasesFromDocs(docs, [], existingNodesStartup);
    if (!result?.phases?.length) return;
    await updateStore((draft) => {
      const { phases: newPhases, nodes: newNodes, nodeAssignments } = result;
      draft.currentStage = { ...(draft.currentStage || {}), phases: newPhases };
      if ((newNodes || []).length) {
        const cur = draft.currentStage.checklist?.length ? draft.currentStage.checklist : defaultStageChecklist;
        const oldById = new Map(cur.map((n) => [n.id, n]));
        const newNodeSet = new Set(newNodes.map((n) => n.id));
        const merged = [
          ...newNodes.map((n) => {
            const old = oldById.get(n.id);
            return old ? { ...old, title: n.title || old.title, acceptance: n.acceptance || old.acceptance, phaseId: n.phaseId || old.phaseId } : n;
          }),
          ...cur.filter((n) => !newNodeSet.has(n.id) && (n.taskIds?.length > 0))
        ];
        draft.currentStage.checklist = reassignChecklistPhaseIds(merged, newPhases, nodeAssignments || {});
      }
      return draft;
    });
    console.log('[Startup] phases 修正完成，共', result.phases.length, '个阶段');
  } catch (e) {
    console.error('[Startup] 异步 phases 修正失败:', e.message);
  }
}, 3000);

server.listen(port, host, () => {
  const prepHour = meetingHour === 0 ? 23 : meetingHour - 1;
  console.log(`
╔═══════════════════════════════════════════════╗
║         CUE Project Hub 启动成功              ║
╚═══════════════════════════════════════════════╝
  地址：http://${host}:${port}
  Hub：${hubUrl}

  环境变量状态：
    ANTHROPIC_API_KEY  ${process.env.ANTHROPIC_API_KEY ? '✅ 已配置（LLM 功能启用）' : '❌ 未配置（降级规则引擎）'}
    GITHUB_TOKEN       ${process.env.GITHUB_TOKEN ? '✅ 已配置（GitHub API 同步）' : '❌ 未配置（限速 60次/小时）'}
    WECOM_WEBHOOK_URL  ${process.env.WECOM_WEBHOOK_URL ? '✅ 已配置（企微推送启用）' : '❌ 未配置（推送不可用）'}
    CUE_API_KEY        ${process.env.CUE_API_KEY ? '✅ 已配置（写接口鉴权）' : '⚪ 未配置（写接口对外开放）'}
    HUB_URL            ${hubUrl}
    MEETING_HOUR       ${meetingHour}:00（作战包 ${prepHour}:45 自动推送）
    GITHUB_AUTO_SYNC   ${githubSyncIntervalMinutes > 0 ? `✅ 每 ${githubSyncIntervalMinutes} 分钟同步一次` : '⏸️ 已关闭'}
`);
});
