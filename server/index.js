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
import { scanGitHubProject, hasGitHubConfig } from './services/githubApi.js';
import { callClaude, parseJsonOutput } from './services/claude.js';
import { buildStageChecklist } from './services/stageChecklist.js';
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

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
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
    linkedRefs: Array.isArray(input.linkedRefs) ? input.linkedRefs : []
  };
}

function getDateParam(url) {
  return url.searchParams.get('date') || todayText();
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

  // 1. 快照：保存生成时刻的提交和分工，供后续对照分析使用（不受后续新 commit 影响）
  const snapshotCommits = (store.activities || []).filter(
    (a) => a.type === 'commit' && String(a.createdAt || a.date || '').slice(0, 10) === date
  );
  const snapshotAssignments = (store.assignments || []).filter((a) => a.date === date);
  const dateReviews = (store.reviews || []).filter(
    (r) => (r.createdAt || '').slice(0, 10) === date
  );

  // 2. 规则引擎：生成结构化晚报（对账表、nextTargets、进度更新）
  const structuredReport = buildEveningReport(store, date);

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
  const SYSTEM = `你是 CUE Project Hub 的计划调整 AI。根据最新的 GitHub 提交记录，结合当前任务状态，判断是否需要调整任务计划，并输出简短的调整建议（Markdown，不超过 200 字）。如果不需要调整，输出"无需调整"。`;
  const activeTasks = (store.tasks || []).filter((t) => t.status !== '已完成').slice(0, 10);
  const commitSummary = activities.map((a) => `- ${a.owner}: ${a.title} (${a.repo || ''})`).join('\n');
  const taskSummary = activeTasks.map((t) => `- [${t.status}] ${t.title}（${t.owner}）进度${t.progress}%`).join('\n');
  const text = await callClaude(SYSTEM, `最新提交：\n${commitSummary}\n\n当前任务：\n${taskSummary}`);
  if (!text || text.includes('无需调整')) return null;
  return text;
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
    activity.type === 'commit' && !existingReviewIds.has(`review_${activity.sha}`)
  ));
  const commitReviews = await Promise.all(
    reviewCandidates.map(async (activity) => ({
      id: `review_${activity.sha}`,
      projectId: project.id,
      activityId: activity.id,
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
    sendJson(res, 200, {
      ...store,
      alerts,
      metrics: buildMetrics(store, alerts),
      stageChecklist: buildStageChecklist(store)
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

    const nextStore = await updateStore((draft) => {
      draft.assignments = [assignment, ...(draft.assignments || [])].slice(0, 500);
      return draft;
    });
    sendJson(res, 201, {
      assignment,
      assignments: (nextStore.assignments || []).filter((item) => item.date === assignment.date)
    });
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
        .filter((activity) => activity.type === 'commit')
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
      const importLimit = Number(url.searchParams.get('limit') || process.env.DOC_TASK_IMPORT_LIMIT || 8);
      const importCandidates = selectDailyDocTasks(parsedTasks, importLimit);
      let imported = 0;
      if (importCandidates.length) {
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
          return draft;
        });
      }
      result.steps.syncDocs = { ok: true, imported, selected: importCandidates.length, totalCandidates: parsedTasks.length };
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
      ...await reviewChange(json || {})
    };
    const nextStore = await updateStore((store) => {
      store.reviews.unshift(review);
      return store;
    });
    sendJson(res, 201, { review, reviews: nextStore.reviews });
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
      generatePlanAdjustment(activities, nextStore).then((suggestion) => {
        if (suggestion) {
          updateStore((draft) => {
            draft.planAdjustments = draft.planAdjustments || [];
            draft.planAdjustments.unshift({
              id: createId('adjust'),
              date: new Date().toISOString().slice(0, 10),
              trigger: activities.map((a) => a.title).join('; '),
              suggestion,
              createdAt: new Date().toISOString()
            });
            draft.planAdjustments = draft.planAdjustments.slice(0, 50);
            return draft;
          });
        }
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

  // POST /api/assignments — 领取任务
  if (req.method === 'POST' && url.pathname === '/api/assignments') {
    const { json } = await readBody(req);
    if (!json?.owner || !json?.taskId) {
      sendError(res, 400, '缺少 owner 或 taskId 字段');
      return true;
    }
    const store = await loadStore();
    const task = (store.tasks || []).find((t) => t.id === json.taskId);
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const assignment = {
      id: createId('assign'),
      date: today,
      owner: String(json.owner).trim(),
      taskId: json.taskId,
      taskTitle: task ? task.title : String(json.taskTitle || json.taskId),
      note: String(json.note || '').trim(),
      status: '进行中',
      createdAt: now,
      updatedAt: now
    };
    const nextStore = await updateStore((draft) => {
      // 同一人同一任务同一天只保留最新一条
      draft.assignments = (draft.assignments || []).filter(
        (a) => !(a.owner === assignment.owner && a.taskId === assignment.taskId && a.date === today)
      );
      draft.assignments.unshift(assignment);
      return draft;
    });
    sendJson(res, 201, { assignment, assignments: (nextStore.assignments || []).filter((a) => a.date === today) });
    return true;
  }

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
  let githubSyncRunning = false;
  const prepHour = meetingHour === 0 ? 23 : meetingHour - 1; // 前一小时
  const prepMinute = 45;

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
  }, 60_000);
}

startScheduler();

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
