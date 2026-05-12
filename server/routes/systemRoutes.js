import {
  createSessionToken,
  findUserForProject,
  hashPassword,
  sanitizeUser,
  userCanManageProject,
  verifyPassword,
  verifySessionToken
} from '../services/auth.js';

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.headers['x-cue-session-token'] || '';
}

function getSessionUser(req, users, projectId) {
  const session = verifySessionToken(getBearerToken(req));
  if (!session || session.projectId !== projectId) return null;
  const user = users.find((item) => item.id === session.sub && item.active !== false) || null;
  return user && userCanManageProject(user, projectId) ? user : null;
}

export function createSystemRoutes({
  loadStore,
  updateStore,
  readBody = async () => ({ json: {} }),
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

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { json } = await readBody(req);
      const username = String(json?.username || '').trim();
      const password = String(json?.password || '');
      const projectId = String(json?.projectId || '').trim();
      const store = await loadStore();
      const fallbackProjectId = (store.projects || [])[0]?.id || 'cue_ai_classroom';
      const targetProjectId = projectId || fallbackProjectId;
      const user = findUserForProject(store.users || [], username, targetProjectId);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        sendJson(res, 401, { ok: false, error: 'invalid credentials' });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        user: sanitizeUser(user),
        projectId: targetProjectId,
        token: createSessionToken(user, targetProjectId)
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/users') {
      const projectId = url.searchParams.get('projectId') || '';
      const store = await loadStore();
      const targetProjectId = projectId || (store.projects || [])[0]?.id || 'cue_ai_classroom';
      const adminUser = getSessionUser(req, store.users || [], targetProjectId);
      if (!adminUser) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return true;
      }
      const users = (store.users || [])
        .filter((user) => user.active !== false && (user.projectIds || []).some((id) => id === '*' || id === targetProjectId))
        .map(sanitizeUser);
      sendJson(res, 200, { users });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/users') {
      if (typeof updateStore !== 'function') {
        sendJson(res, 500, { ok: false, error: 'auth store is not writable' });
        return true;
      }
      const { json } = await readBody(req);
      const projectId = String(json?.projectId || '').trim();
      const username = String(json?.username || '').trim();
      const password = String(json?.password || '');
      const name = String(json?.name || username).trim();
      const role = ['developer', 'project_admin'].includes(json?.role) ? json.role : 'developer';
      if (!projectId || !username || !password) {
        sendJson(res, 400, { ok: false, error: 'projectId, username and password are required' });
        return true;
      }

      const before = await loadStore();
      const tokenAdmin = getSessionUser(req, before.users || [], projectId);
      const credentialAdmin = (() => {
        const adminUsername = String(json?.adminUsername || '').trim();
        const adminPassword = String(json?.adminPassword || '');
        const candidate = findUserForProject(before.users || [], adminUsername, projectId);
        return candidate && verifyPassword(adminPassword, candidate.passwordHash) && userCanManageProject(candidate, projectId)
          ? candidate
          : null;
      })();
      const adminUser = tokenAdmin || credentialAdmin;
      if (!adminUser) {
        sendJson(res, 403, { ok: false, error: 'project admin credentials required' });
        return true;
      }
      if ((before.users || []).some((user) => user.username === username)) {
        sendJson(res, 409, { ok: false, error: 'username already exists' });
        return true;
      }

      const now = new Date().toISOString();
      let createdUser = null;
      await updateStore((draft) => {
        draft.users = draft.users || [];
        createdUser = {
          id: `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          username,
          name,
          role,
          projectIds: [projectId],
          active: true,
          passwordHash: hashPassword(password),
          createdAt: now,
          updatedAt: now
        };
        draft.users.push(createdUser);
        return draft;
      });
      sendJson(res, 201, { ok: true, user: sanitizeUser(createdUser) });
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
