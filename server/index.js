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
// ── V2 地基初始化（在任何路由注册之前）──────────────────────
import { initDb } from './db/index.js';
import './state/reducer.js';                // 注册 reducer 订阅者（状态机）
import './events/outcomeHandlers.js';       // 注册 Outcome Ledger 事件订阅（W9 闭合）
import './events/eveningReportHandler.js';  // 晚会作战包 EventBus 迁移（ENABLE_V2_EVENING=true 时生效）
import { replayUnprocessed } from './events/bus.js';
import { initAdapters } from './adapters/index.js';
import { handleV2 } from './v2/app.js';
import { getFastifyApp } from './v2/fastifyApp.js';  // Part N.1 Fastify 层
import { handleV2AppRequest, isV2AppPath } from './v2/appFacade.js';
import logger from './logger.js';
const { db: _v2db, kysely: _v2kysely } = initDb();
await replayUnprocessed();            // 重启后回放未处理事件
initAdapters();                       // 通信平台适配器
// sqlite-vec 向量索引（P2 真 RAG）— 异步初始化，失败时优雅降级
import { initVectorStore, rebuildMemoryIndex } from './services/vectorStore.js';
const { supported: _vecSupported } = await initVectorStore(_v2db);
if (_vecSupported) rebuildMemoryIndex(_v2db); // 补全旧数据向量（首次启动）
// Part N.1: 初始化 Fastify v2 层（/v2/health 走 Fastify，其余桥接 handleV2）
const _fastifyApp = await getFastifyApp();
logger.info(`[V2] DB + EventBus + reducers + outcome-handlers + adapters + vector-store(${_vecSupported ? 'ON' : 'OFF'}) + Fastify initialized`);
// ── END V2 初始化 ───────────────────────────────────────────

import { createId, loadStore, saveStore, updateStore } from './store.js';
import { setCorsHeaders, sendJson, sendError, readBody, normalizeTask, isCompanyWorkday } from './utils.js';
import {
  generatePlan,
  estimateTasksProgress,
  generatePlanAdjustment,
  generatePlanAlternatives,
  normalizePlanStageUpdate,
  applyPlanAdjustmentToStage,
  persistPlanAdjustment
} from './services/planner.js';
import { reviewChange } from './services/reviewer.js';
import { buildMetrics, scanRisks } from './services/riskEngine.js';
import { parseGitHubEvent, verifyGitHubSignature } from './services/githubWebhook.js';
import { scanLocalGitProject } from './services/localGit.js';
import { scanGitHubProject, hasGitHubConfig, fetchCommitDetail, mergePR, getBranchProtection, parseRepo, createBranch, createFileOnBranch, createDraftPR, ownerToLogin } from './services/githubApi.js';
import { syncGitHubProjectIntoStore, githubSyncErrorHint } from './services/githubSync.js';
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
  writeProgressToGitHub,
  importDocsForProject
} from './services/docsManager.js';
import {
  applyEveningReportProgress,
  buildEveningReport,
  normalizeAssignment,
  normalizeStandup,
  todayText,
  generateEveningReport
} from './services/dailyBrief.js';
import { refreshAnalysisIntoStore } from './services/semanticLinker.js';
import { generateAssignmentBrief } from './services/assignmentBrief.js';
import { bindActivityToExplicitRefs } from './services/bindingEngine.js';
import { getSessionToken, verifySessionToken } from './services/auth.js';
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
import { createScoringRoutes } from './routes/scoringRoutes.js';
import { createRecommendationRoutes } from './routes/recommendationRoutes.js';
import {
  generateDailyTaskSuggestions,
  LLMUnavailableError
} from './services/dailyTaskSuggester.js';
import { startScheduler, runStartupPhaseCorrection } from './scheduler.js';
import { startCron } from './cron/index.js';
import { createPullRoutes } from './routes/pullRoutes.js';
import { handlePrAgentSink, upsertPullFromWebhook } from './services/pullPipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || '127.0.0.1';
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '';
const cueApiKey = process.env.CUE_API_KEY || '';
const hubUrl = process.env.HUB_URL || 'https://hub.cueai.top';
const wecomBotName = process.env.WECOM_BOT_NAME || 'CUE项目中枢';
const attendanceBotName = process.env.WECOM_ATTENDANCE_BOT_NAME || '团队考勤';
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

function hasValidApiKey(req) {
  if (!cueApiKey) return true;
  const provided = req.headers['x-cue-api-key'];
  return typeof provided === 'string' && provided === cueApiKey;
}

function hasValidSession(req) {
  const token = getSessionToken(req);
  return Boolean(verifySessionToken(token));
}

function requiresApiKey(req, url) {
  if (!cueApiKey) return false;
  if (!url.pathname.startsWith('/api/')) return false;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  if (url.pathname === '/api/webhooks/github') return false;
  if (url.pathname === '/api/auth/login') return false;
  if (url.pathname === '/api/auth/email-code') return false;
  if (url.pathname === '/api/auth/phone-code') return false;
  if (url.pathname === '/api/auth/me') return false;
  if (url.pathname === '/api/auth/users') return false;
  // 企微插件接口无需 API key（企微本身已是内部工具）
  if (url.pathname.startsWith('/api/wecom/')) return false;
  return true;
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
    hubUrl,
    wecomBotName
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
    refreshAnalysisIntoStore,
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
    buildProgressMarkdown,
    writeProgressToGitHub,
    refreshAnalysisIntoStore,
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
  createScoringRoutes({
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    todayText
  }),
  createRecommendationRoutes({
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    generateDailyTaskSuggestions,
    LLMUnavailableError,
    normalizeAssignment
  }),
  createTaskRoutes({
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    normalizeTask,
    estimateTasksProgress,
    generatePlan,
    createBranch,
    createFileOnBranch,
    createDraftPR,
    parseRepo,
    ownerToLogin
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
  createPullRoutes({
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    mergePR,
    getBranchProtection,
    parseRepo,
    sendWeComMarkdown,
    isWeComAvailable,
    hubUrl
  }),
  createWebhookRoutes({
    createId,
    loadStore,
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
    bindActivityToExplicitRefs,
    importDocsForProject,
    handlePrAgentSink,
    cueApiKey,
    upsertPullFromWebhook
  })
];

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
    // ── V2 App facade：主前端走 /v2/app/*，内部复用现有业务路由 ───────
    if (isV2AppPath(url)) {
      await handleV2AppRequest({
        req,
        res,
        url,
        requiresApiKey,
        hasValidApiKey,
        hasValidSession,
        sendError,
        handleApi,
      });
      return;
    }

    // ── V2 路由：/v2/* 走 Fastify（Part N.1）───────────────────
    // Fastify /v2/health → 原生处理；其余 → handleV2 bridge
    if (url.pathname.startsWith('/v2/')) {
      _fastifyApp.routing(req, res);
      return;
    }

    // ── [experiment/v2-standalone] v1 /api/* 已禁用 ──────────────
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }
      sendError(res, 404, 'v1 API disabled — use /v2/*');
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendError(res, 500, 'internal server error', error.message);
  }
});

startScheduler({
  loadStore,
  updateStore,
  createId,
  syncGitHubProjectIntoStore,
  hasGitHubConfig,
  generateEveningReport,
  buildProgressMarkdown,
  writeProgressToGitHub,
  importDocsForProject,
  refreshAnalysisIntoStore,
  generateDailyTaskSuggestions,
  isWeComAvailable,
  sendWeComMarkdown,
  todayText,
  isCompanyWorkday,
  githubSyncIntervalMinutes,
  githubSyncLimit,
  githubSyncDiffLimit,
  meetingHour,
  hubUrl,
  wecomBotName,
  attendanceBotName
});

// ── node-cron 定时调度（替代 scheduler.js setInterval，P2 迁移进行中）──────
// 当前：仅启用每日 db.json 快照（23:55 CST）
// 晚会和 GitHub 同步仍由 scheduler.js setInterval 负责，避免双重触发
// 完全迁移需要为 evening.report.due / doc.scan.requested 事件添加 v2 reducer 处理
startCron({
  meetingHour,
  githubSyncIntervalMinutes: 0,   // 禁用 cron 侧的 GitHub 同步（scheduler.js 已有）
  isCompanyWorkday,
  todayText,
});

setTimeout(() => runStartupPhaseCorrection({
  loadStore,
  updateStore,
  fetchProjectDocs,
  parsePhasesFromDocs,
  defaultStageChecklist,
  reassignChecklistPhaseIds
}), 3000);

// ── 启动时全量同步 JSON store → SQLite（让 v2 接口读到真实业务数据）──
import { syncJsonToSqlite } from './services/jsonToSqliteSync.js';
loadStore().then(store => syncJsonToSqlite(store)).catch(err =>
  logger.warn('[startup] JSON→SQLite 初始同步失败:', err.message)
);

server.listen(port, host, () => {
  const prepHour = meetingHour === 0 ? 23 : meetingHour - 1;
  logger.info(`
╔═══════════════════════════════════════════════╗
║         CUE Project Hub 启动成功              ║
╚═══════════════════════════════════════════════╝
  地址：http://${host}:${port}
  Hub：${hubUrl}

  环境变量状态：
    OPENAI_API_KEY     ${process.env.OPENAI_API_KEY ? '✅ 已配置（LLM 功能启用）' : '❌ 未配置（降级规则引擎）'}
    GITHUB_TOKEN       ${process.env.GITHUB_TOKEN ? '✅ 已配置（GitHub API 同步）' : '❌ 未配置（限速 60次/小时）'}
    WECOM_WEBHOOK_URL  ${process.env.WECOM_WEBHOOK_URL ? '✅ 已配置（企微推送启用）' : '❌ 未配置（推送不可用）'}
    WECOM_BOT_NAME     @${wecomBotName}（项目中枢/查询机器人）
    WECOM_ATTENDANCE_BOT_NAME @${attendanceBotName}（任务完成/晚会出席签到机器人）
    CUE_API_KEY        ${process.env.CUE_API_KEY ? '✅ 已配置（写接口鉴权）' : '⚪ 未配置（写接口对外开放）'}
    SMTP               ${process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS ? '✅ 已配置（邮箱验证码启用）' : '⚪ 未配置（页面显示开发验证码）'}
    HUB_URL            ${hubUrl}
    MEETING_HOUR       ${meetingHour}:00（作战包 ${prepHour}:45 自动推送）
    GITHUB_AUTO_SYNC   ${githubSyncIntervalMinutes > 0 ? `✅ 每 ${githubSyncIntervalMinutes} 分钟同步一次` : '⏸️ 已关闭'}
`);
});
