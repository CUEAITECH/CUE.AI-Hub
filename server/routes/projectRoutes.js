import { getTenantId, isProjectFounder, verifySessionToken } from '../services/auth.js';
import { importDocsForProject, makeSlugId } from '../services/docsManager.js';
import logger from '../logger.js';


function getProjectRepo(project) {
  if (project.githubFullRepo?.includes('/')) {
    const [owner, repo] = project.githubFullRepo.split('/');
    return { owner, repo };
  }
  return { owner: project.githubOwner || '', repo: project.repository || '' };
}

export function createProjectRoutes({
  createId,
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  hasGitHubConfig,
  scanGitHubProject,
  scanLocalGitProject,
  syncGitHubProjectIntoStore,
  githubSyncErrorHint,
  reviewChange,
  scanRisks,
  buildMetrics,
  buildProgressMarkdown,
  writeProgressToGitHub,
  refreshAnalysisIntoStore,
  todayText
}) {
  const slugId = makeSlugId(createId);

  function normalizeProjectInput(input = {}, fallbackId = '') {
    const owner = String(input.githubOwner || '').trim();
    const repository = String(input.repository || '').trim();
    const explicitFullRepo = String(input.githubFullRepo || '').trim();
    const githubFullRepo = explicitFullRepo || (owner && repository ? `${owner}/${repository}` : '');
    const [repoOwner = owner, repoName = repository] = githubFullRepo.includes('/')
      ? githubFullRepo.split('/')
      : [owner, repository];
    const name = String(input.name || repoName || fallbackId || '').trim();
    const id = String(input.id || fallbackId || '').trim();
    return {
      id,
      name,
      githubOwner: repoOwner || owner,
      repository: repoName || repository,
      githubFullRepo,
      localPath: String(input.localPath || '').trim(),
      branch: String(input.branch || '').trim(),
      status: String(input.status || '待同步').trim(),
      lastSyncAt: input.lastSyncAt || '',
      summary: String(input.summary || '').trim()
    };
  }

  function countProjectLinks(store, projectId) {
    return {
      tasks: (store.tasks || []).filter((item) => item.projectId === projectId).length,
      activities: (store.activities || []).filter((item) => item.projectId === projectId).length,
      assignments: (store.assignments || []).filter((item) => item.projectId === projectId).length,
      reviews: (store.reviews || []).filter((item) => item.projectId === projectId).length,
      deliverables: (store.deliverables || []).filter((item) => item.projectId === projectId).length,
      phases: (store.phases || []).filter((item) => item.projectId === projectId).length
    };
  }

  async function runProjectSync(project, scanOptions) {
    if (hasGitHubConfig(project)) {
      return scanGitHubProject(project, scanOptions);
    }
    if (project.localPath) {
      logger.warn(`[Sync] 项目 ${project.id} 未配置 githubOwner，降级到本地 git（建议配置远端）`);
      return scanLocalGitProject(project, scanOptions);
    }
    throw new Error(`项目 "${project.name || project.id}" 既未配置 githubOwner，也没有 localPath，无法同步`);
  }

  async function importDocs(project, projectId, url) {
    const importLimit = Number(url.searchParams.get('limit') || process.env.DOC_TASK_IMPORT_LIMIT || 8);
    return importDocsForProject(project, projectId, importLimit);
  }

  return async function projectRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const store = await loadStore(getTenantId(req));
      sendJson(res, 200, { projects: store.projects || [] });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const { json } = await readBody(req);
      if (!json) { sendError(res, 400, 'invalid json'); return true; }
      const id = String(json.id || slugId('project', json.githubFullRepo || json.repository || json.name)).trim();
      const project = normalizeProjectInput(json, id);
      if (!project.name) { sendError(res, 400, 'project name required'); return true; }
      const store = await loadStore(getTenantId(req));
      if ((store.projects || []).some((item) => item.id === project.id)) {
        sendError(res, 409, 'project id already exists');
        return true;
      }
      // 把当前调用者（session 中的 user）设为创始人，自动赋项目管理员角色
      const callerSession = (() => {
        const headers = req.headers || {};
        const header = headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (headers['x-cue-session-token'] || '');
        return verifySessionToken(token);
      })();
      const callerUser = callerSession
        ? (store.users || []).find((u) => u.id === callerSession.sub && u.active !== false)
        : null;
      const nextStore = await updateStore((draft) => {
        draft.projects = draft.projects || [];
        draft.projects.push({
          ...project,
          founderId: callerUser?.id || '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        // 创始人自动获得本项目的 project_admin 角色
        if (callerUser) {
          const idx = (draft.users || []).findIndex((u) => u.id === callerUser.id);
          if (idx !== -1) {
            const u = draft.users[idx];
            const roles = u.projectRoles && typeof u.projectRoles === 'object' ? u.projectRoles : {};
            draft.users[idx] = {
              ...u,
              projectIds: Array.from(new Set([...(u.projectIds || []), project.id])),
              projectRoles: { ...roles, [project.id]: 'project_admin' },
              updatedAt: new Date().toISOString()
            };
          }
        }
        return draft;
      }, getTenantId(req));
      const saved = (nextStore.projects || []).find((item) => item.id === project.id);
      if (!saved) { sendError(res, 409, 'project id already exists'); return true; }
      sendJson(res, 201, { project: saved });
      return true;
    }

    // 转移项目创始人：只有当前创始人本人能调用
    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/transfer-founder')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const { json } = await readBody(req);
      const targetUsername = String(json?.targetUsername || '').trim();
      if (!targetUsername) { sendError(res, 400, 'targetUsername required'); return true; }
      const before = await loadStore(getTenantId(req));
      const project = (before.projects || []).find((p) => p.id === projectId);
      if (!project) { sendError(res, 404, 'project not found'); return true; }
      const callerSession = (() => {
        const headers = req.headers || {};
        const header = headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (headers['x-cue-session-token'] || '');
        return verifySessionToken(token);
      })();
      const callerUser = callerSession
        ? (before.users || []).find((u) => u.id === callerSession.sub && u.active !== false)
        : null;
      if (!callerUser || !isProjectFounder(callerUser, project)) {
        sendError(res, 403, 'only the current founder can transfer ownership');
        return true;
      }
      const target = (before.users || []).find((u) =>
        u.username === targetUsername && u.active !== false && u.id !== callerUser.id
      );
      if (!target) { sendError(res, 404, 'target user not found or is current founder'); return true; }
      const now = new Date().toISOString();
      await updateStore((draft) => {
        const pIdx = (draft.projects || []).findIndex((p) => p.id === projectId);
        if (pIdx !== -1) draft.projects[pIdx] = { ...draft.projects[pIdx], founderId: target.id, updatedAt: now };
        // 新创始人 → project_admin
        const tIdx = (draft.users || []).findIndex((u) => u.id === target.id);
        if (tIdx !== -1) {
          const u = draft.users[tIdx];
          const roles = u.projectRoles && typeof u.projectRoles === 'object' ? u.projectRoles : {};
          draft.users[tIdx] = {
            ...u,
            projectIds: Array.from(new Set([...(u.projectIds || []), projectId])),
            projectRoles: { ...roles, [projectId]: 'project_admin' },
            updatedAt: now
          };
        }
        // 老创始人保留 project_admin 角色（不强降，留个管理权）
        return draft;
      }, getTenantId(req));
      sendJson(res, 200, { ok: true, projectId, newFounderId: target.id, newFounderUsername: target.username });
      return true;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/projects/') &&
        !url.pathname.includes('/sync')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const { json } = await readBody(req);
      if (!json) { sendError(res, 400, 'invalid json'); return true; }
      const nextStore = await updateStore((draft) => {
        const index = (draft.projects || []).findIndex((project) => project.id === projectId);
        if (index === -1) return draft;
        const allowed = ['name', 'repository', 'githubOwner', 'githubFullRepo', 'localPath', 'summary', 'branch', 'status'];
        const patch = Object.fromEntries(Object.entries(json).filter(([key]) => allowed.includes(key)));
        const normalizedPatch = normalizeProjectInput({ ...draft.projects[index], ...patch }, projectId);
        const current = draft.projects[index];
        const repoChanged = ['repository', 'githubOwner', 'githubFullRepo', 'localPath']
          .some((key) => Object.hasOwn(patch, key) && normalizedPatch[key] !== current[key]);
        const shouldResetSync = repoChanged || json.resetSync === true;
        draft.projects[index] = {
          ...current,
          ...normalizedPatch,
          id: current.id,
          ...(shouldResetSync
            ? {
                branch: '',
                status: '待同步',
                lastSyncAt: '',
                commitCount: 0,
                dirtyFileCount: 0
              }
            : {}),
          updatedAt: new Date().toISOString()
        };
        return draft;
      }, getTenantId(req));
      const project = (nextStore.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, 'project not found'); return true; }
      sendJson(res, 200, { project });
      return true;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/projects/')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const store = await loadStore(getTenantId(req));
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, 'project not found'); return true; }
      if (projectId === 'cue_ai_classroom' || (store.projects || []).length <= 1) {
        sendError(res, 409, 'default project cannot be deleted');
        return true;
      }
      const links = countProjectLinks(store, projectId);
      const linkedCount = Object.values(links).reduce((sum, count) => sum + count, 0);
      if (linkedCount > 0) {
        sendError(res, 409, 'project has linked records', {
          message: '为避免误删真实研发数据，请先清理或迁移该项目下的任务、提交、分工和审阅记录。',
          links
        });
        return true;
      }
      const nextStore = await updateStore((draft) => {
        draft.projects = (draft.projects || []).filter((item) => item.id !== projectId);
        return draft;
      }, getTenantId(req));
      sendJson(res, 200, { deleted: true, projectId, projects: nextStore.projects || [] });
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-github')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const store = await loadStore(getTenantId(req));
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, 'project not found'); return true; }
      if (!hasGitHubConfig(project)) {
        sendError(res, 400, `项目未配置 githubOwner，请先 PATCH /api/projects/${projectId} 设置 githubOwner 和 repository`);
        return true;
      }

      try {
        const result = await syncGitHubProjectIntoStore(project, {
          since: url.searchParams.get('since') || '14 days ago',
          limit: Number(url.searchParams.get('limit') || 15)
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendError(res, 422, 'GitHub 同步失败', githubSyncErrorHint(project, err));
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-local-git')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const store = await loadStore(getTenantId(req));
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) {
        sendError(res, 404, 'project not found');
        return true;
      }

      const scanOptions = {
        since: url.searchParams.get('since') || '14 days ago',
        limit: Number(url.searchParams.get('limit') || 12)
      };
      const scan = await runProjectSync(project, scanOptions);

      const commitReviews = await Promise.all(
        scan.activities
          .filter((activity) => activity.type === 'commit' && String(activity.title || '').trim().length > 0)
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
      }, getTenantId(req));

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

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-docs')) {
      const projectId = url.pathname.split('/')[3];
      const store = await loadStore(getTenantId(req));
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, '项目不存在'); return true; }

      try {
        const result = await importDocs(project, projectId, url);
        sendJson(res, 200, result);
      } catch (err) {
        if (err.message.includes('githubFullRepo')) {
          sendError(res, 400, err.message);
        } else {
          sendError(res, 500, 'internal server error', err.message);
        }
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/update-docs')) {
      const projectId = url.pathname.split('/')[3];
      const store = await loadStore(getTenantId(req));
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, '项目不存在'); return true; }

      const { owner, repo } = getProjectRepo(project);
      if (!owner || !repo) { sendError(res, 400, '项目未配置 githubFullRepo'); return true; }

      const docTasks = (store.docTasks || {})[projectId] || [];
      const hubTasks = (store.tasks || []).filter((task) => task.projectId === projectId);
      const deliverables = (store.deliverables || []).filter((item) => item.projectId === projectId);
      const today = todayText();
      const todayAssignments = (store.assignments || []).filter((assignment) =>
        assignment.date === today && assignment.projectId === projectId
      );

      // 风险映射 + commit 覆盖 + 晚会对账（与 daily-scan 复用相同逻辑）
      const rawAlerts = scanRisks(store);
      const analysisById = Object.fromEntries(
        (store.riskAnalyses || []).map((a) => [a.alertId, a])
      );
      const riskByTaskId = {};
      for (const alert of rawAlerts) {
        if (!alert.source) continue;
        const analysis = analysisById[alert.id];
        const severity = analysis?.severity || alert.severity;
        const current = riskByTaskId[alert.source];
        if (!current || severity < current.severity) {
          riskByTaskId[alert.source] = { severity, reason: analysis?.reason || alert.detail };
        }
      }
      const progressContext = {
        riskByTaskId,
        commitTaskLinks: store.semanticLinks?.commitTaskLinks || [],
        eveningReports: store.eveningReports || {}
      };
      const markdown = buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, today, deliverables, progressContext);
      await writeProgressToGitHub(owner, repo, markdown);

      sendJson(res, 200, { written: true, path: 'docs/阶段进度追踪.md', date: today });
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/daily-scan')) {
      const projectId = url.pathname.split('/')[3];
      const store = await loadStore(getTenantId(req));
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, '项目不存在'); return true; }

      const result = { projectId, steps: {} };

      try {
        const { owner, repo } = getProjectRepo(project);
        if (owner && repo) {
          const syncResult = await scanGitHubProject(project, { maxCommits: 30 });
          if (syncResult) {
            await updateStore((draft) => {
              const newActivities = syncResult.activities || [];
              const retained = (draft.activities || []).filter((activity) =>
                !newActivities.find((nextActivity) => nextActivity.id === activity.id)
              );
              draft.activities = [...newActivities, ...retained].slice(0, 700);
              return draft;
            }, getTenantId(req));
            result.steps.syncCommits = { ok: true, added: syncResult.activities?.length || 0 };
          }
        }
      } catch (err) {
        result.steps.syncCommits = { ok: false, error: err.message };
      }

      // Step 1.5：语义分析 + 风险分析，让后续 importDocs/buildProgressMarkdown 用最新数据
      // refreshAnalysisIntoStore 内部已直接 import loadStore/updateStore，并调用 buildHybridAnalysis 写回
      try {
        const analysis = await refreshAnalysisIntoStore();
        result.steps.refreshAnalysis = { ok: true, generatedAt: analysis.generatedAt, llmEnabled: analysis.llmEnabled };
      } catch (err) {
        result.steps.refreshAnalysis = { ok: false, error: err.message };
        // 非致命：后续步骤继续用缓存的 semanticLinks
      }

      try {
        const docsResult = await importDocs(project, projectId, url);
        result.steps.syncDocs = {
          ok: true,
          imported: docsResult.imported,
          selected: docsResult.selected || 0,
          totalCandidates: docsResult.totalCandidates || 0,
          phases: docsResult.phases || 0,
          createdDeliverables: docsResult.createdDeliverables || 0,
          docSuggestComplete: docsResult.docSuggestComplete || 0
        };
      } catch (err) {
        result.steps.syncDocs = { ok: false, error: err.message };
      }

      try {
        const freshStore = await loadStore(getTenantId(req));
        const { owner, repo } = getProjectRepo(project);
        const docTasks = (freshStore.docTasks || {})[projectId] || [];
        const hubTasks = (freshStore.tasks || []).filter((task) => task.projectId === projectId);
        const deliverables = (freshStore.deliverables || []).filter((item) => item.projectId === projectId);
        const today = todayText();
        const todayAssignments = (freshStore.assignments || []).filter((assignment) =>
          assignment.date === today && assignment.projectId === projectId
        );
        // 构建进度文档上下文：风险映射 + commit 覆盖 + 晚会对账
        const rawAlerts = scanRisks(freshStore);
        const analysisById = Object.fromEntries(
          (freshStore.riskAnalyses || []).map((a) => [a.alertId, a])
        );
        const riskByTaskId = {};
        for (const alert of rawAlerts) {
          if (!alert.source) continue;
          const analysis = analysisById[alert.id];
          const severity = analysis?.severity || alert.severity;
          const current = riskByTaskId[alert.source];
          if (!current || severity < current.severity) {
            riskByTaskId[alert.source] = { severity, reason: analysis?.reason || alert.detail };
          }
        }
        const progressContext = {
          riskByTaskId,
          commitTaskLinks: freshStore.semanticLinks?.commitTaskLinks || [],
          eveningReports: freshStore.eveningReports || {}
        };
        const markdown = buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, today, deliverables, progressContext);
        await writeProgressToGitHub(owner, repo, markdown);
        result.steps.updateDocs = { ok: true };
      } catch (err) {
        result.steps.updateDocs = { ok: false, error: err.message };
      }

      sendJson(res, 200, result);
      return true;
    }

    return false;
  };
}
