function getProjectRepo(project) {
  if (project.githubFullRepo?.includes('/')) {
    const [owner, repo] = project.githubFullRepo.split('/');
    return { owner, repo };
  }
  return { owner: project.githubOwner || '', repo: project.repository || '' };
}

function mergeStageChecklist(draft, parsedPhasesResult, defaultStageChecklist, reassignChecklistPhaseIds) {
  if (!parsedPhasesResult?.phases?.length) return;

  const { phases: newPhases, nodes: newNodes, nodeAssignments } = parsedPhasesResult;
  draft.currentStage = { ...(draft.currentStage || {}), phases: newPhases };
  if (!(newNodes || []).length) return;

  const currentChecklist = draft.currentStage.checklist?.length
    ? draft.currentStage.checklist : defaultStageChecklist;
  const oldById = new Map(currentChecklist.map((node) => [node.id, node]));
  const newNodeSet = new Set(newNodes.map((node) => node.id));
  const mergedNodes = [
    ...newNodes.map((node) => {
      const old = oldById.get(node.id);
      return old
        ? {
            ...old,
            title: node.title || old.title,
            acceptance: node.acceptance || old.acceptance,
            phaseId: node.phaseId || old.phaseId
          }
        : node;
    }),
    ...currentChecklist.filter((node) => !newNodeSet.has(node.id) && (node.taskIds?.length > 0))
  ];
  draft.currentStage.checklist = reassignChecklistPhaseIds(mergedNodes, newPhases, nodeAssignments || {});
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
  fetchProjectDocs,
  parseDocsForTasks,
  parseProgressDoc,
  parsePhasesFromDocs,
  selectDailyDocTasks,
  buildProgressMarkdown,
  writeProgressToGitHub,
  defaultStageChecklist,
  reassignChecklistPhaseIds,
  todayText
}) {
  function slugId(prefix, value) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^\w\u3400-\u9fff]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    return `${prefix}_${normalized || createId('node').replace(/^node_/, '')}`;
  }

  function normalizeTitle(value) {
    return String(value || '').replace(/\s+/g, '').replace(/[【】()[\]（）]/g, '').toLowerCase();
  }

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

  function findDeliverableByTitle(deliverables = [], title = '') {
    const key = normalizeTitle(title);
    if (!key) return null;
    return deliverables.find((item) => {
      const candidate = normalizeTitle(item.title);
      return candidate === key || candidate.includes(key) || key.includes(candidate);
    }) || null;
  }

  function applyProgressDocSuggestions(draft, docs) {
    const progressDoc = (docs || []).find((doc) => String(doc.name || doc.path || '').includes('阶段进度追踪'));
    if (!progressDoc) return 0;
    const progressItems = parseProgressDoc(progressDoc.content || '');
    let suggested = 0;
    draft.deliverables = draft.deliverables || [];
    for (const item of progressItems) {
      if (item.docStatus !== '已完成') continue;
      const deliverable = findDeliverableByTitle(draft.deliverables, item.title);
      if (!deliverable || deliverable.status === '已完成' || deliverable.manualOverride?.status === '已完成') continue;
      deliverable.docSuggestComplete = true;
      deliverable.docStatus = item.docStatus;
      deliverable.docStatusUpdatedAt = new Date().toISOString();
      suggested++;
    }
    return suggested;
  }

  async function runProjectSync(project, scanOptions) {
    if (hasGitHubConfig(project)) {
      return scanGitHubProject(project, scanOptions);
    }
    if (project.localPath) {
      console.warn(`[Sync] 项目 ${project.id} 未配置 githubOwner，降级到本地 git（建议配置远端）`);
      return scanLocalGitProject(project, scanOptions);
    }
    throw new Error(`项目 "${project.name || project.id}" 既未配置 githubOwner，也没有 localPath，无法同步`);
  }

  async function importDocs(project, projectId, url) {
    const { owner, repo } = getProjectRepo(project);
    if (!owner || !repo) {
      throw new Error('项目未配置 githubFullRepo，请先 PATCH 设置');
    }

    const docs = await fetchProjectDocs(owner, repo);
    if (!docs.length) {
      return { imported: 0, message: 'docs/ 目录无计划文档' };
    }

    const parsedTasks = await parseDocsForTasks(docs);
    if (!parsedTasks.length) {
      return { imported: 0, message: 'LLM 未解析出任务（无 API key 或文档无可执行任务）' };
    }

    const storeSnap = await loadStore();
    const planDocs = docs.filter((doc) => !String(doc.name || doc.path || '').includes('阶段进度追踪'));
    const existingNodes = (storeSnap.currentStage?.checklist?.length
      ? storeSnap.currentStage.checklist : defaultStageChecklist
    ).map((node) => ({ id: node.id, title: node.title, phaseId: node.phaseId }));
    const parsedPhasesResult = await parsePhasesFromDocs(planDocs, parsedTasks, existingNodes);
    const importLimit = Number(url.searchParams.get('limit') || process.env.DOC_TASK_IMPORT_LIMIT || 8);
    const importCandidates = selectDailyDocTasks(parsedTasks, importLimit);

    let imported = 0;
    let createdDeliverables = 0;
    let docSuggestions = 0;
    const nextStore = await updateStore((draft) => {
      const existing = draft.tasks || [];
      draft.deliverables = draft.deliverables || [];
      for (const task of importCandidates) {
        let deliverable = findDeliverableByTitle(draft.deliverables, task.deliverableTitle || task.title);
        if (!deliverable && (task.deliverableTitle || task.title)) {
          deliverable = {
            id: slugId('deliverable', task.deliverableTitle || task.title),
            projectId,
            phaseId: parsedPhasesResult?.nodes?.find((node) => normalizeTitle(node.title) === normalizeTitle(task.deliverableTitle))?.phaseId || null,
            title: task.deliverableTitle || task.title,
            owner: task.owner || '',
            acceptance: task.description || '',
            keywords: [task.title, task.deliverableTitle, task.sourceDoc].filter(Boolean),
            status: task.status === 'completed' ? '已完成' : task.status === 'in_progress' ? '推进中' : '待补证据',
            progress: task.status === 'completed' ? 100 : 0,  // 进度由子任务聚合，不在此硬编码
            sourceDocPath: task.sourceDoc || '',
            docSuggestComplete: false,
            manualOverride: null,
            taskIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          draft.deliverables.push(deliverable);
          createdDeliverables++;
        }
        const duplicate = existing.find(
          (item) => item.title === task.title && item.sourceDoc === task.sourceDoc
        );
        if (!duplicate) {
          const taskId = createId('task');
          existing.unshift({
            id: taskId,
            title: task.title,
            owner: task.owner || '',
            priority: task.priority || 'P1',
            status: task.status || 'pending',
            description: task.description || '',
            dueDate: task.dueDate || '',
            sourceDoc: task.sourceDoc || '',
            projectId,
            deliverableId: deliverable?.id || null,
            acceptance: '',
            createdAt: new Date().toISOString()
          });
          if (deliverable && !deliverable.taskIds?.includes(taskId)) {
            deliverable.taskIds = [...(deliverable.taskIds || []), taskId];
          }
          imported++;
        } else if (deliverable) {
          // 无论原来有没有 deliverableId，都更新为当前匹配的 deliverable（修正历史错误绑定）
          duplicate.deliverableId = deliverable.id;
          if (!deliverable.taskIds?.includes(duplicate.id)) {
            deliverable.taskIds = [...(deliverable.taskIds || []), duplicate.id];
          }
        }
      }
      draft.tasks = existing;
      if (!draft.docTasks) draft.docTasks = {};
      draft.docTasks[projectId] = parsedTasks;
      mergeStageChecklist(draft, parsedPhasesResult, defaultStageChecklist, reassignChecklistPhaseIds);
      docSuggestions = applyProgressDocSuggestions(draft, docs);
      return draft;
    });

    return {
      imported,
      selected: importCandidates.length,
      totalCandidates: parsedTasks.length,
      importLimit: Math.min(Math.max(Number.isFinite(importLimit) ? Math.floor(importLimit) : 8, 1), 20),
      message: `已从 ${parsedTasks.length} 个候选任务中选择 ${importCandidates.length} 个适合近期领取的任务导入。`,
      importedTasks: nextStore.tasks.filter((task) => (
        task.projectId === projectId && importCandidates.some((candidate) =>
          candidate.title === task.title && candidate.sourceDoc === task.sourceDoc
        )
      )),
      candidates: parsedTasks,
      phases: parsedPhasesResult?.phases?.length || 0,
      createdDeliverables,
      docSuggestComplete: docSuggestions
    };
  }

  return async function projectRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const store = await loadStore();
      sendJson(res, 200, { projects: store.projects || [] });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const { json } = await readBody(req);
      if (!json) { sendError(res, 400, 'invalid json'); return true; }
      const id = String(json.id || slugId('project', json.githubFullRepo || json.repository || json.name)).trim();
      const project = normalizeProjectInput(json, id);
      if (!project.name) { sendError(res, 400, 'project name required'); return true; }
      const store = await loadStore();
      if ((store.projects || []).some((item) => item.id === project.id)) {
        sendError(res, 409, 'project id already exists');
        return true;
      }
      const nextStore = await updateStore((draft) => {
        draft.projects = draft.projects || [];
        draft.projects.push({
          ...project,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return draft;
      });
      const saved = (nextStore.projects || []).find((item) => item.id === project.id);
      if (!saved) { sendError(res, 409, 'project id already exists'); return true; }
      sendJson(res, 201, { project: saved });
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
      });
      const project = (nextStore.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, 'project not found'); return true; }
      sendJson(res, 200, { project });
      return true;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/projects/')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const store = await loadStore();
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
      });
      sendJson(res, 200, { deleted: true, projectId, projects: nextStore.projects || [] });
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-github')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const store = await loadStore();
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
      const store = await loadStore();
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
      });

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
      const store = await loadStore();
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
      const store = await loadStore();
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

      const markdown = buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, today, deliverables);
      await writeProgressToGitHub(owner, repo, markdown);

      sendJson(res, 200, { written: true, path: 'docs/阶段进度追踪.md', date: today });
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/daily-scan')) {
      const projectId = url.pathname.split('/')[3];
      const store = await loadStore();
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
            });
            result.steps.syncCommits = { ok: true, added: syncResult.activities?.length || 0 };
          }
        }
      } catch (err) {
        result.steps.syncCommits = { ok: false, error: err.message };
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
        const freshStore = await loadStore();
        const { owner, repo } = getProjectRepo(project);
        const docTasks = (freshStore.docTasks || {})[projectId] || [];
        const hubTasks = (freshStore.tasks || []).filter((task) => task.projectId === projectId);
        const deliverables = (freshStore.deliverables || []).filter((item) => item.projectId === projectId);
        const today = todayText();
        const todayAssignments = (freshStore.assignments || []).filter((assignment) =>
          assignment.date === today && assignment.projectId === projectId
        );
        const markdown = buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, today, deliverables);
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
