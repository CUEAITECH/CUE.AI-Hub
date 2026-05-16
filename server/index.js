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
import { scanGitHubProject, hasGitHubConfig, fetchCommitDetail } from './services/githubApi.js';
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
  importDocCandidates
} from './services/docsManager.js';
import {
  applyEveningReportProgress,
  buildEveningReport,
  normalizeAssignment,
  normalizeStandup,
  todayText,
  generateEveningReport
} from './services/dailyBrief.js';
import { buildHybridAnalysis } from './services/semanticLinker.js';
import { generateAssignmentBrief } from './services/assignmentBrief.js';
import { bindActivityToExplicitRefs } from './services/bindingEngine.js';
import { verifySessionToken } from './services/auth.js';
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
import { startScheduler, runStartupPhaseCorrection } from './scheduler.js';

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

function hasValidApiKey(req) {
  if (!cueApiKey) return true;
  const provided = req.headers['x-cue-api-key'];
  return typeof provided === 'string' && provided === cueApiKey;
}

function hasValidSession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : req.headers['x-cue-session-token'] || '';
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
    buildProgressMarkdown,
    writeProgressToGitHub,
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

      if (requiresApiKey(req, url) && !hasValidApiKey(req) && !hasValidSession(req)) {
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

startScheduler({
  loadStore,
  updateStore,
  createId,
  syncGitHubProjectIntoStore,
  hasGitHubConfig,
  generateEveningReport,
  buildProgressMarkdown,
  writeProgressToGitHub,
  importDocCandidates,
  buildHybridAnalysis,
  isWeComAvailable,
  sendWeComMarkdown,
  todayText,
  isCompanyWorkday,
  githubSyncIntervalMinutes,
  githubSyncLimit,
  githubSyncDiffLimit,
  meetingHour,
  hubUrl
});

setTimeout(() => runStartupPhaseCorrection({
  loadStore,
  updateStore,
  fetchProjectDocs,
  parsePhasesFromDocs,
  defaultStageChecklist,
  reassignChecklistPhaseIds
}), 3000);

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
    SMTP               ${process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS ? '✅ 已配置（邮箱验证码启用）' : '⚪ 未配置（页面显示开发验证码）'}
    HUB_URL            ${hubUrl}
    MEETING_HOUR       ${meetingHour}:00（作战包 ${prepHour}:45 自动推送）
    GITHUB_AUTO_SYNC   ${githubSyncIntervalMinutes > 0 ? `✅ 每 ${githubSyncIntervalMinutes} 分钟同步一次` : '⏸️ 已关闭'}
`);
});
