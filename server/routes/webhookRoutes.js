import logger from '../logger.js';
// 进行中的项目级任务（防止 webhook 突发流量导致 LLM 调用堆积）
const inFlightDocsSync = new Set();
const inFlightPlanAdjust = new Set();

export function createWebhookRoutes({
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
}) {
  return async function webhookRoutes(req, res, url) {
    // PR-Agent sink（GitHub Actions 通知 Hub：PR-Agent 已完成 review）
    if (req.method === 'POST' && url.pathname === '/api/webhooks/pr-agent') {
      // 验证 CUE_API_KEY（复用同一把 key）
      const provided = req.headers['x-cue-api-key'];
      if (cueApiKey && provided !== cueApiKey) {
        sendError(res, 401, 'invalid api key');
        return true;
      }
      const { json } = await readBody(req);
      if (!json || !json.repo || !json.pr_number) {
        sendError(res, 400, 'missing repo or pr_number');
        return true;
      }
      const currentStore = await loadStore();
      const pull = handlePrAgentSink
        ? await handlePrAgentSink(json, currentStore, updateStore)
        : null;
      sendJson(res, 202, { received: true, pull: pull ? { id: pull.id, number: pull.number } : null });
      return true;
    }

    // C+ bypass 记录（main-push-policy.yml 推送）
    if (req.method === 'POST' && url.pathname === '/api/webhooks/bypass') {
      const provided = req.headers['x-cue-api-key'];
      if (cueApiKey && provided !== cueApiKey) {
        sendError(res, 401, 'invalid api key');
        return true;
      }
      const { json } = await readBody(req);
      if (!json?.sha || !json?.branch) {
        sendJson(res, 200, { received: true, skipped: true });
        return true;
      }
      // 只有 hotfix/* 分支才记录
      const isHotfix = String(json.branch || '').startsWith('hotfix/');
      if (!isHotfix) {
        sendJson(res, 200, { received: true, skipped: 'not-hotfix' });
        return true;
      }
      const deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await updateStore((draft) => {
        if (!Array.isArray(draft.bypasses)) draft.bypasses = [];
        const existing = draft.bypasses.find((b) => b.sha === json.sha);
        if (!existing) {
          draft.bypasses.unshift({
            id: createId('bypass'),
            sha: json.sha,
            branch: json.branch,
            author: json.author || '',
            repo: json.repo || '',
            deadline,
            prLinked: false,
            alertSent: false,
            createdAt: new Date().toISOString()
          });
          draft.bypasses = draft.bypasses.slice(0, 100);
        }
        return draft;
      });
      sendJson(res, 202, { received: true, deadline });
      return true;
    }

    if (req.method !== 'POST' || url.pathname !== '/api/webhooks/github') return false;

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

    // PR 事件：单 PR 实时 upsert（替代每 10 分钟批量轮询）
    if (eventName === 'pull_request' && typeof upsertPullFromWebhook === 'function') {
      const repoFull = json.repository?.full_name || '';
      const prNumber = json.pull_request?.number;
      if (repoFull && prNumber) {
        upsertPullFromWebhook(repoFull, prNumber, json.action)
          .catch((err) => logger.error('[Webhook/PR]', err.message));
      }
    }

    const currentStore = loadStore ? await loadStore() : null;
    for (const activity of activities) {
      if (activity.type === 'pull_request') {
        const bound = bindActivityToExplicitRefs && currentStore
          ? bindActivityToExplicitRefs(activity, currentStore)
          : activity;
        const linkedTask = bound.taskId && currentStore
          ? (currentStore.tasks || []).find((t) => t.id === bound.taskId)
          : null;
        reviews.push({
          id: createId('review'),
          ...await reviewChange({
            repo: activity.repo,
            title: activity.title,
            owner: activity.actor,
            diff: `${activity.action || ''} ${activity.branch || ''}`,
            files: activity.files,
            task: linkedTask || null
          })
        });
      }
    }

    let boundActivities = activities;
    const nextStore = await updateStore((store) => {
      boundActivities = activities.map((activity) => (
        bindActivityToExplicitRefs ? bindActivityToExplicitRefs(activity, store) : activity
      ));
      store.activities = [...boundActivities, ...(store.activities || [])].slice(0, 500);
      store.reviews = [...reviews, ...(store.reviews || [])].slice(0, 200);
      return store;
    });

    if (boundActivities.length > 0) {
      // 用 webhook 中第一个 activity 的 repo 当 key（一次 webhook 通常是一个 repo）
      const planKey = boundActivities[0].repo || 'unknown';
      if (!inFlightPlanAdjust.has(planKey)) {
        inFlightPlanAdjust.add(planKey);
        generatePlanAdjustment(boundActivities, nextStore).then((adjustment) => {
          if (!adjustment) return null;
          return persistPlanAdjustment(adjustment, boundActivities, 'github-webhook');
        }).catch((err) => logger.error('[PlanAdjust]', err.message)).finally(() => {
          inFlightPlanAdjust.delete(planKey);
        });
      } else {
        logger.info(`[Webhook] plan-adjust 跳过 ${planKey}：已有进行中任务`);
      }
    }

    // 检测 push 是否改动 docs/*.md，自动触发 sync-docs（不阻塞 webhook 响应）
    const reposWithDocsChanges = new Set();
    for (const activity of boundActivities) {
      if (activity.type !== 'commit') continue;
      const touched = (activity.files || []).some((f) => /^docs\/.*\.md$/.test(f));
      if (touched) reposWithDocsChanges.add((activity.repo || '').toLowerCase());
    }
    if (reposWithDocsChanges.size > 0 && typeof importDocsForProject === 'function') {
      const candidateProjects = (nextStore.projects || []).filter((p) =>
        reposWithDocsChanges.has(String(p.githubFullRepo || '').toLowerCase())
      );
      for (const project of candidateProjects) {
        if (inFlightDocsSync.has(project.id)) {
          logger.info(`[Webhook] docs sync 跳过 ${project.githubFullRepo}：已有进行中任务`);
          continue;
        }
        inFlightDocsSync.add(project.id);
        importDocsForProject(project, project.id).then((result) => {
          logger.info(`[Webhook] docs/ 变更触发 sync-docs：${project.githubFullRepo} — 新增任务 ${result.imported || 0}，phases ${result.phases || 0}`);
        }).catch((err) => {
          logger.error(`[Webhook] docs sync 失败 ${project.githubFullRepo}：`, err.message);
        }).finally(() => {
          inFlightDocsSync.delete(project.id);
        });
      }
    }

    sendJson(res, 202, {
      received: true,
      event: eventName,
      activities: boundActivities,
      reviews,
      metrics: buildMetrics(nextStore, scanRisks(nextStore))
    });
    return true;
  };
}
