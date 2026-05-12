export function createTaskRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  normalizeTask,
  estimateTasksProgress,
  generatePlan
}) {
  return async function taskRoutes(req, res, url) {
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

    if (req.method === 'POST' && url.pathname === '/api/tasks/ai-progress') {
      const store = await loadStore();
      const results = await estimateTasksProgress(store);
      if (!results.length) {
        sendJson(res, 200, { tasks: store.tasks, suggestions: [], message: '无关联提交，无法估算进度。' });
        return true;
      }

      const next = await updateStore((draft) => {
        for (const result of results) {
          const task = draft.tasks.find((item) => item.id === result.taskId);
          if (!task) continue;
          const newProgress = Math.max(0, Math.min(100, Number(result.progress) || 0));
          const isManualProgress = task.progressSource === 'manual' || Boolean(task.completionSource);
          const appliedProgress = isManualProgress ? Math.max(task.progress || 0, newProgress) : newProgress;
          task.progress = appliedProgress;
          task.progressSource = isManualProgress ? 'manual' : 'auto';
          task.aiProgressSuggestion = {
            progress: newProgress,
            appliedProgress,
            reason: String(result.reason || '').slice(0, 80),
            hint: String(result.hint || '').slice(0, 100),
            suggestComplete: !!result.suggestComplete,
            updatedAt: new Date().toISOString()
          };
        }
        return draft;
      });
      sendJson(res, 200, {
        tasks: next.tasks,
        suggestions: results.filter((result) => result.suggestComplete).map((result) => result.taskId)
      });
      return true;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const { json } = await readBody(req);
      const nextStore = await updateStore((store) => {
        const index = store.tasks.findIndex((task) => task.id === id);
        if (index === -1) return store;
        const manualPatch = Object.hasOwn(json || {}, 'progress')
          || Object.hasOwn(json || {}, 'status')
          || Object.hasOwn(json || {}, 'completionSource');
        store.tasks[index] = normalizeTask({
          ...store.tasks[index],
          ...json,
          id,
          createdAt: store.tasks[index].createdAt,
          progressSource: manualPatch ? 'manual' : store.tasks[index].progressSource
        });
        return store;
      });
      const task = nextStore.tasks.find((item) => item.id === id);
      if (!task) sendError(res, 404, 'task not found');
      else sendJson(res, 200, { task, tasks: nextStore.tasks });
      return true;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(url.pathname.split('/')[3] || '');
      const nextStore = await updateStore((store) => {
        store.tasks = store.tasks.filter((task) => task.id !== id);
        return store;
      });
      sendJson(res, 200, { deleted: id, tasks: nextStore.tasks });
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

    return false;
  };
}
