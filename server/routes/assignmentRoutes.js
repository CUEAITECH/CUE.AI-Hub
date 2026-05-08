export function createAssignmentRoutes({
  loadStore,
  updateStore,
  normalizeAssignment,
  generateAssignmentBrief,
  todayText,
  readBody,
  sendJson,
  sendError
}) {
  const getDateParam = (url) => url.searchParams.get('date') || todayText();

  function refreshAssignmentBrief(assignment, task, store, label = 'Brief') {
    generateAssignmentBrief({ task, owner: assignment.owner, note: assignment.note, store })
      .then((brief) => updateStore((draft) => {
        const idx = (draft.assignments || []).findIndex((item) => item.id === assignment.id);
        if (idx >= 0) {
          draft.assignments[idx].brief = brief;
          draft.assignments[idx].briefGeneratedBy = brief.generatedBy;
        }
        return draft;
      }))
      .catch((err) => console.error(`[${label}]`, err.message));
  }

  return async function assignmentRoutes(req, res, url) {
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

      const task = (store.tasks || []).find((item) => item.id === assignment.taskId) || null;
      refreshAssignmentBrief(assignment, task, store);
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/assignments/') && url.pathname.endsWith('/brief')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
      const store = await loadStore();
      const assignment = (store.assignments || []).find((item) => item.id === id);
      if (!assignment) {
        sendError(res, 404, 'assignment not found');
        return true;
      }
      const task = (store.tasks || []).find((item) => item.id === assignment.taskId) || null;
      sendJson(res, 202, { message: '细则生成已触发', assignments: store.assignments });
      refreshAssignmentBrief(assignment, task, store, 'Brief/Retry');
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
      if (!updated) {
        sendError(res, 404, 'assignment not found');
      } else {
        sendJson(res, 200, {
          assignment: updated,
          assignments: (nextStore.assignments || []).filter((item) => item.date === updated.date)
        });
      }
      return true;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/assignments/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const nextStore = await updateStore((draft) => {
        draft.assignments = (draft.assignments || []).filter((assignment) => assignment.id !== id);
        return draft;
      });
      sendJson(res, 200, { deleted: id, assignments: nextStore.assignments || [] });
      return true;
    }

    return false;
  };
}
