export function createPullRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError
}) {
  return async function pullRoutes(req, res, url) {
    // GET /api/pulls  — 列表（支持 ?projectId=&state=&author= 筛选）
    if (req.method === 'GET' && url.pathname === '/api/pulls') {
      const store = await loadStore();
      let pulls = store.pulls || [];
      const { projectId, state, author } = Object.fromEntries(url.searchParams);
      if (projectId) pulls = pulls.filter((p) => p.projectId === projectId);
      if (state) pulls = pulls.filter((p) => p.state === state);
      if (author) pulls = pulls.filter((p) => p.author === author);
      sendJson(res, 200, { pulls });
      return true;
    }

    // GET /api/pulls/:id
    if (req.method === 'GET' && url.pathname.match(/^\/api\/pulls\/[^/]+$/)) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const store = await loadStore();
      const pull = (store.pulls || []).find((p) => p.id === id);
      if (!pull) { sendError(res, 404, 'pull not found'); return true; }
      sendJson(res, 200, { pull });
      return true;
    }

    // PATCH /api/pulls/:id/decision  — 人工决策（Pass / Escalate）
    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/pulls\/[^/]+\/decision$/)) {
      const id = decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]);
      const { json } = await readBody(req);
      const allowed = ['Pass', 'Escalate', 'acknowledged', 'needs-fix', 'exempted'];
      const decision = allowed.includes(json?.humanDecision) ? json.humanDecision : null;
      if (!decision) { sendError(res, 400, 'invalid humanDecision'); return true; }

      let updated = null;
      await updateStore((draft) => {
        const idx = (draft.pulls || []).findIndex((p) => p.id === id);
        if (idx === -1) return draft;
        updated = {
          ...draft.pulls[idx],
          humanDecision: decision,
          humanNote: String(json?.humanNote || '').trim() || '',
          humanAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        draft.pulls[idx] = updated;
        return draft;
      });

      if (!updated) { sendError(res, 404, 'pull not found'); return true; }
      sendJson(res, 200, { pull: updated });
      return true;
    }

    return false;
  };
}
