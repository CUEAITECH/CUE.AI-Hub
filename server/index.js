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
import {
  aggregateDeliverableProgress,
  buildStageChecklist,
  normalizeStageName,
  normalizeStageShortName,
  defaultStageChecklist,
  reassignChecklistPhaseIds
} from './services/stageChecklist.js';
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
  parseProgressDoc,
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
import { bindActivityToExplicitRefs } from './services/bindingEngine.js';
import { dispatchRoutes } from './routes/index.js';
import { createSystemRoutes } from './routes/systemRoutes.js';
import { createAssignmentRoutes } from './routes/assignmentRoutes.js';
import { createWeComRoutes } from './routes/wecomRoutes.js';
import { createProjectRoutes } from './routes/projectRoutes.js';
import { createTaskRoutes } from './routes/taskRoutes.js';
import { createReviewRoutes } from './routes/reviewRoutes.js';
import { createStandupRoutes } from './routes/standupRoutes.js';
import { createReportRoutes } from './routes/reportRoutes.js';
import { createPlanningRoutes } from './routes/planningRoutes.js';
import { createWebhookRoutes } from './routes/webhookRoutes.js';

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
  res.setHeader('access-control-allow-headers', 'content-type, x-cue-api-key, x-cue-session-token, authorization');
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
  if (url.pathname === '/api/auth/login') return false;
  if (url.pathname === '/api/auth/users') return false;
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
    description: input.description || '',
    dueDate: input.dueDate || '',
    sourceDoc: input.sourceDoc || '',
    projectId: input.projectId || 'cue_ai_classroom',
    deliverableId: input.deliverableId || null,
    priority: input.priority || '',
    createdAt: input.createdAt || now,
    updatedAt: now,
    linkedRefs: Array.isArray(input.linkedRefs) ? input.linkedRefs : [],
    aiProgressSuggestion: input.aiProgressSuggestion || null,
    completedBy: input.completedBy || '',
    completedAt: input.completedAt || '',
    completionSource: input.completionSource || '',
    progressSource: input.progressSource || (input.completionSource ? 'manual' : 'auto')
  };
}

function addDaysText(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const routeModules = [
  createSystemRoutes({
    loadStore,
    updateStore,
    readBody,
    scanRisks,
    normalizeStageName,
    buildMetrics,
    buildStageChecklist,
    aggregateDeliverableProgress,
    buildOpenApiSpec,
    sendJson,
    port,
    cueApiKey,
    isWeComAvailable,
    meetingHour,
    hubUrl
  }),
  createPlanningRoutes({
    loadStore,
    saveStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    buildStageChecklist,
    aggregateDeliverableProgress,
    buildHybridAnalysis,
    scanRisks,
    buildMetrics,
    generatePlanAlternatives,
    normalizePlanStageUpdate,
    applyPlanAdjustmentToStage
  }),
  createProjectRoutes({
    createId,
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    hasGitHubConfig,
    scanGitHubProject,
    scanLocalGitProject,
    syncGitHubProjectIntoStore,
    githubSyncErrorHint,
    reviewChange,
    scanRisks,
    buildMetrics,
    fetchProjectDocs,
    parseDocsForTasks,
    parseProgressDoc,
    parsePhasesFromDocs,
    selectDailyDocTasks,
    buildProgressMarkdown,
    writeProgressToGitHub,
    defaultStageChecklist,
    reassignChecklistPhaseIds,
    todayText
  }),
  createAssignmentRoutes({
    loadStore,
    updateStore,
    normalizeAssignment,
    generateAssignmentBrief,
    todayText,
    readBody,
    sendJson,
    sendError
  }),
  createWeComRoutes({
    createId,
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    isWeComAvailable,
    sendWeComMarkdown,
    scanRisks,
    buildMetrics,
    todayText,
    normalizeStandup,
    normalizeTask,
    generateAssignmentBrief
  }),
  createTaskRoutes({
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    normalizeTask,
    estimateTasksProgress,
    generatePlan
  }),
  createReviewRoutes({
    createId,
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    reviewChange,
    fetchCommitDetail,
    callClaude,
    parseJsonOutput
  }),
  createStandupRoutes({
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    normalizeStandup,
    todayText,
    callClaude,
    isWeComAvailable,
    sendWeComMarkdown
  }),
  createReportRoutes({
    loadStore,
    updateStore,
    readBody,
    sendJson,
    buildMetrics,
    scanRisks,
    todayText,
    callClaude,
    isWeComAvailable,
    pushReport,
    sendWeComMarkdown,
    buildMeetingSummaryWeComMsg,
    generateEveningReport,
    hubUrl
  }),
  createWebhookRoutes({
    createId,
    updateStore,
    readBody,
    sendJson,
    sendError,
    verifyGitHubSignature,
    parseGitHubEvent,
    reviewChange,
    generatePlanAdjustment,
    persistPlanAdjustment,
    buildMetrics,
    scanRisks,
    githubWebhookSecret,
    bindActivityToExplicitRefs
  })
];

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
    }).map((activity) => bindActivityToExplicitRefs(activity, draft));
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
          const isManualProgress = task.progressSource === 'manual' || Boolean(task.completionSource);
          const appliedProgress = isManualProgress ? Math.max(task.progress || 0, newProgress) : newProgress;
          task.progress = appliedProgress;
          task.progressSource = isManualProgress ? 'manual' : 'auto';
          task.aiProgressSuggestion = {
            progress: newProgress,
            appliedProgress,
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
  return dispatchRoutes(routeModules, req, res, url);
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
    const ext = extname(filePath);
    // 防止浏览器/CDN 缓存住旧版前端文件：
    // - HTML/JS/CSS 用 no-cache（允许缓存但每次必须向服务器校验，无 ETag 时强制重新拉）
    // - 其他静态资源（图片/字体）保持默认（可长期缓存）
    const noCacheExts = new Set(['.html', '.js', '.css', '.mjs']);
    const headers = {
      'content-type': contentTypes[ext] || 'application/octet-stream'
    };
    if (noCacheExts.has(ext)) {
      headers['cache-control'] = 'no-cache, must-revalidate';
    }
    res.writeHead(200, headers);
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
