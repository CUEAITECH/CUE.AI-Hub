import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// 从 .env 文件加载环境变量（不覆盖已有的系统环境变量）
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
      if (key) process.env[key] = value;
    }
  } catch { /* .env 文件不存在时静默跳过 */ }
}
import { createId, loadStore, saveStore, updateStore } from './store.js';
import { generatePlan } from './services/planner.js';
import { reviewChange } from './services/reviewer.js';
import { buildMetrics, scanRisks } from './services/riskEngine.js';
import { parseGitHubEvent, verifyGitHubSignature } from './services/githubWebhook.js';
import { scanLocalGitProject } from './services/localGit.js';
import { callClaude, parseJsonOutput } from './services/claude.js';
import { isWeComAvailable, pushRiskAlerts, pushReport, sendWeComMarkdown } from './services/wecom.js';

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

  // GET /api/config — 返回前端需要的功能开关（不含密钥）
  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, {
      wecomEnabled: isWeComAvailable(),
      llmEnabled: Boolean(process.env.ANTHROPIC_API_KEY)
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
