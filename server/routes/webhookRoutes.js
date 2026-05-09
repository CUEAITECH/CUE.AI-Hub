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
  bindActivityToExplicitRefs
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
