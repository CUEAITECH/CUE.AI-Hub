import { verifySessionToken } from '../services/auth.js';

export function createRecommendationRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  generateDailyTaskSuggestions,
  LLMUnavailableError,
  normalizeAssignment
}) {

  function getCurrentUser(req, store) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : req.headers['x-cue-session-token'] || '';
    const payload = verifySessionToken(token);
    if (!payload?.sub) return null;
    const user = (store.users || []).find((u) => u.id === payload.sub);
    return user || null;
  }

  return async function recommendationRoutes(req, res, url) {
    // GET /api/recommendations?date=YYYY-MM-DD
    if (req.method === 'GET' && url.pathname === '/api/recommendations') {
      const store = await loadStore();
      const user = getCurrentUser(req, store);
      if (!user) { sendError(res, 401, 'login required'); return true; }

      const date = url.searchParams.get('date') || tomorrowText();
      const entry = store.dailyTaskSuggestions?.[date]?.[user.id];
      if (!entry) {
        sendJson(res, 200, {
          date, candidates: [], message: '今日推荐尚未生成',
          generatedAt: null, generatedBy: null, pool: null
        });
        return true;
      }

      // 把 candidates 里的 taskId 解 hydrate 成完整 task 对象 + acceptedBy
      const candidates = (entry.candidates || []).map((c) => {
        const task = (store.tasks || []).find((t) => t.id === c.taskId);
        const acceptedBy = task && task.owner && task.owner !== '待认领' && task.owner !== user.name
          ? task.owner
          : null;
        return { ...c, task: task || null, acceptedBy };
      });

      sendJson(res, 200, {
        date,
        generatedAt: entry.generatedAt,
        generatedBy: entry.generatedBy,
        candidates,
        pool: entry.pool
      });
      return true;
    }

    // POST /api/recommendations/refresh
    if (req.method === 'POST' && url.pathname === '/api/recommendations/refresh') {
      const store = await loadStore();
      const user = getCurrentUser(req, store);
      if (!user) { sendError(res, 401, 'login required'); return true; }

      const { json } = await readBody(req);
      const date = (json && json.date) || tomorrowText();

      // 老 candidates 标 superseded
      await updateStore((draft) => {
        draft.dailyTaskSuggestions = draft.dailyTaskSuggestions || {};
        draft.dailyTaskSuggestions[date] = draft.dailyTaskSuggestions[date] || {};
        const existing = draft.dailyTaskSuggestions[date][user.id];
        if (existing?.candidates?.length) {
          for (const c of existing.candidates) {
            if (c.status === 'pending') c.status = 'superseded';
          }
        }
        return draft;
      });

      // 重新生成
      const fresh = await loadStore();
      try {
        const result = await generateDailyTaskSuggestions(date, user.id, fresh, { triggeredBy: 'manual' });
        await updateStore((draft) => {
          draft.dailyTaskSuggestions[date][user.id] = {
            generatedAt: new Date().toISOString(),
            generatedBy: 'manual',
            pool: result.pool,
            candidates: result.candidates
          };
          return draft;
        });
        const after = await loadStore();
        const entry = after.dailyTaskSuggestions[date][user.id];
        sendJson(res, 200, { date, ...entry });
      } catch (err) {
        if (err instanceof LLMUnavailableError) {
          sendError(res, 503, 'AI 推荐暂不可用', err.message);
          return true;
        }
        throw err;
      }
      return true;
    }

    // POST /api/recommendations/:taskId/accept
    const acceptMatch = url.pathname.match(/^\/api\/recommendations\/([^/]+)\/accept$/);
    if (req.method === 'POST' && acceptMatch) {
      const taskId = acceptMatch[1];
      const store = await loadStore();
      const user = getCurrentUser(req, store);
      if (!user) { sendError(res, 401, 'login required'); return true; }

      const { json } = await readBody(req);
      const date = (json && json.date) || tomorrowText();

      const task = (store.tasks || []).find((t) => t.id === taskId);
      if (!task) { sendError(res, 404, 'task not found'); return true; }
      if (task.owner && task.owner !== '待认领' && task.owner !== user.name) {
        sendJson(res, 409, { error: 'task already taken', acceptedBy: task.owner });
        return true;
      }

      // 原子更新：task.owner + 创建 assignment + candidate.status=accepted
      let assignment = null;
      let candidateSnapshot = null;
      await updateStore((draft) => {
        const t = (draft.tasks || []).find((x) => x.id === taskId);
        if (!t) return draft;
        t.owner = user.name;
        t.updatedAt = new Date().toISOString();

        assignment = normalizeAssignment({
          taskId: t.id,
          taskTitle: t.title,
          owner: user.name,
          date,
          note: 'AI 推荐接受',
          aiSuggested: true,
          aiSuggestionRef: { date, userId: user.id, taskId: t.id }
        }, draft);
        draft.assignments = [assignment, ...(draft.assignments || [])].slice(0, 500);

        draft.dailyTaskSuggestions = draft.dailyTaskSuggestions || {};
        const dayEntry = draft.dailyTaskSuggestions[date]?.[user.id];
        if (dayEntry) {
          const cand = dayEntry.candidates.find((c) => c.taskId === taskId);
          if (cand) {
            cand.status = 'accepted';
            cand.actedAt = new Date().toISOString();
            cand.acceptedAssignmentId = assignment.id;
            candidateSnapshot = { ...cand };
          }
        }
        return draft;
      });

      sendJson(res, 200, { assignment, candidate: candidateSnapshot });
      return true;
    }

    return false;
  };
}

function tomorrowText() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
