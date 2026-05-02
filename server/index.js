import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createId, loadStore, saveStore, updateStore } from './store.js';
import { generatePlan } from './services/planner.js';
import { reviewChange } from './services/reviewer.js';
import { buildMetrics, scanRisks } from './services/riskEngine.js';
import { parseGitHubEvent, verifyGitHubSignature } from './services/githubWebhook.js';
import { scanLocalGitProject } from './services/localGit.js';
import {
  applyEveningReportProgress,
  buildEveningReport,
  normalizeAssignment,
  normalizeStandup,
  todayText
} from './services/dailyBrief.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || '127.0.0.1';
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '';

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
      metrics: buildMetrics(store, alerts)
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const store = await loadStore();
    sendJson(res, 200, { tasks: store.tasks });
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

  if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-local-git')) {
    const parts = url.pathname.split('/');
    const projectId = decodeURIComponent(parts[3] || '');
    const store = await loadStore();
    const project = (store.projects || []).find((item) => item.id === projectId);

    if (!project) {
      sendError(res, 404, 'project not found');
      return true;
    }

    const scan = await scanLocalGitProject(project, {
      since: url.searchParams.get('since') || '14 days ago',
      limit: Number(url.searchParams.get('limit') || 12)
    });

    const commitReviews = scan.activities
      .filter((activity) => activity.type === 'commit')
      .map((activity) => ({
        id: `review_${activity.sha}`,
        projectId: project.id,
        activityId: activity.id,
        ...reviewChange({
          repo: project.repository,
          title: activity.title,
          owner: activity.owner,
          diff: activity.diff || activity.files.join('\n'),
          files: activity.files
        })
      }));
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
    const tasks = generatePlan(json?.goal || '', store.members);
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
      ...reviewChange(json || {})
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
    sendJson(res, 200, {
      date,
      report: store.eveningReports?.[date] || null
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/reports/evening') {
    const { json } = await readBody(req);
    const date = json?.date || todayText();
    const baseStore = await loadStore();
    const eveningReport = buildEveningReport(baseStore, date);
    const progressedStore = applyEveningReportProgress(baseStore, eveningReport);
    const alerts = scanRisks(progressedStore);
    const nextStore = await saveStore({
      ...progressedStore,
      eveningReports: {
        ...(progressedStore.eveningReports || {}),
        [date]: eveningReport
      },
      alerts
    });
    sendJson(res, 201, {
      report: eveningReport,
      tasks: nextStore.tasks,
      currentStage: nextStore.currentStage,
      alerts,
      metrics: buildMetrics(nextStore, alerts)
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
          ...reviewChange({
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

    sendJson(res, 202, {
      received: true,
      event: eventName,
      activities,
      reviews,
      metrics: buildMetrics(nextStore, scanRisks(nextStore))
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
      const handled = await handleApi(req, res, url);
      if (!handled) sendError(res, 404, 'api route not found');
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendError(res, 500, 'internal server error', error.message);
  }
});

server.listen(port, host, () => {
  console.log(`CUE Project Hub running at http://${host}:${port}`);
});
