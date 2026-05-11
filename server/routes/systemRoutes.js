export function createSystemRoutes({
  loadStore,
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
}) {
  return async function systemRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, name: 'CUE Project Hub', time: new Date().toISOString() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const store = await loadStore();
      const requestedProjectId = url.searchParams.get('projectId') || '';
      const projectIds = (store.projects || []).map((project) => project.id);
      const projectId = requestedProjectId
        ? (projectIds.includes(requestedProjectId) ? requestedProjectId : projectIds[0] || requestedProjectId)
        : '';
      const byProject = (items = []) => projectId
        ? items.filter((item) => !item.projectId || item.projectId === projectId)
        : items;
      const scopedStore = projectId
        ? {
            ...store,
            tasks: byProject(store.tasks || []),
            reviews: byProject(store.reviews || []),
            activities: byProject(store.activities || []),
            assignments: byProject(store.assignments || []),
            standups: byProject(store.standups || []),
            alerts: byProject(store.alerts || []),
            deliverables: byProject(store.deliverables || []),
            phases: byProject(store.phases || [])
          }
        : store;
      const alerts = scanRisks(scopedStore);
      const currentStage = normalizeStageName(scopedStore.currentStage || {});
      sendJson(res, 200, {
        ...scopedStore,
        projects: store.projects || [],
        currentProjectId: projectId || (store.projects || [])[0]?.id || '',
        currentStage,
        alerts,
        metrics: buildMetrics(scopedStore, alerts),
        stageChecklist: buildStageChecklist({ ...scopedStore, currentStage }),
        deliverableProgress: aggregateDeliverableProgress(scopedStore)
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const store = await loadStore();
      const status = url.searchParams.get('status');
      const tasks = status ? store.tasks.filter((task) => task.status === status) : store.tasks;
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
      sendJson(res, 200, buildOpenApiSpec(`${proto}://${host}`));
      return true;
    }

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

    return false;
  };
}
