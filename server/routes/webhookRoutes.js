export function createWebhookRoutes({
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
  bindActivityToExplicitRefs,
  importDocsForProject
}) {
  return async function webhookRoutes(req, res, url) {
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
      generatePlanAdjustment(boundActivities, nextStore).then((adjustment) => {
        if (!adjustment) return null;
        return persistPlanAdjustment(adjustment, boundActivities, 'github-webhook');
      }).catch((err) => console.error('[PlanAdjust]', err.message));
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
        importDocsForProject(project, project.id).then((result) => {
          console.log(`[Webhook] docs/ 变更触发 sync-docs：${project.githubFullRepo} — 新增任务 ${result.imported || 0}，phases ${result.phases || 0}`);
        }).catch((err) => {
          console.error(`[Webhook] docs sync 失败 ${project.githubFullRepo}：`, err.message);
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
