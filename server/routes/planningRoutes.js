export function createPlanningRoutes({
  loadStore,
  saveStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  buildStageChecklist,
  aggregateDeliverableProgress,
  buildHybridAnalysis,
  scanRisks,
  buildMetrics,
  generatePlanAlternatives,
  normalizePlanStageUpdate,
  applyPlanAdjustmentToStage
}) {
  return async function planningRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/stage/checklist') {
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
            deliverables: byProject(store.deliverables || []),
            phases: byProject(store.phases || [])
          }
        : store;
      sendJson(res, 200, buildStageChecklist(scopedStore));
      return true;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/stage/checklist/')) {
      const nodeId = decodeURIComponent(url.pathname.slice('/api/stage/checklist/'.length));
      const { json } = await readBody(req);
      const status = json?.status;
      if (!status) { sendError(res, 400, 'status required'); return true; }
      const next = await updateStore((draft) => {
        if (!draft.checklistOverrides) draft.checklistOverrides = {};
        if (status === 'reset') {
          delete draft.checklistOverrides[nodeId];
        } else {
          draft.checklistOverrides[nodeId] = { status, by: json.by || '手动', at: new Date().toISOString() };
        }
        if (Array.isArray(draft.deliverables)) {
          draft.deliverables = draft.deliverables.map((deliverable) => {
            if (deliverable.id !== nodeId) return deliverable;
            return {
              ...deliverable,
              manualOverride: status === 'reset'
                ? null
                : { status, by: json.by || '手动', at: new Date().toISOString() },
              updatedAt: new Date().toISOString()
            };
          });
        }
        return draft;
      });
      sendJson(res, 200, {
        stageChecklist: buildStageChecklist(next),
        deliverableProgress: aggregateDeliverableProgress(next)
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/ai/refresh-analysis') {
      const store = await loadStore();
      const analysis = await buildHybridAnalysis(store);
      const nextStore = await updateStore((draft) => ({
        ...draft,
        semanticLinks: analysis.semanticLinks || {},
        riskAnalyses: analysis.riskAnalyses || [],
        healthAnalysis: analysis.healthAnalysis || null,
        aiAnalysisUpdatedAt: analysis.generatedAt
      }));
      const alerts = scanRisks(nextStore);
      sendJson(res, 200, {
        semanticLinks: nextStore.semanticLinks,
        riskAnalyses: nextStore.riskAnalyses,
        healthAnalysis: nextStore.healthAnalysis,
        aiAnalysisUpdatedAt: nextStore.aiAnalysisUpdatedAt,
        metrics: buildMetrics(nextStore, alerts),
        alerts,
        stageChecklist: buildStageChecklist(nextStore),
        deliverableProgress: aggregateDeliverableProgress(nextStore)
      });
      return true;
    }

    // 清洗任务数据：去重 + 修正 成员A/B/C 占位符
    if (req.method === 'POST' && url.pathname === '/api/tasks/cleanup') {
      const MEMBER_PLACEHOLDER = /^成员\s*[A-Ea-e一二三四五]$|^Member\s*[A-Ea-e]$/i;
      const VALID_OWNERS = new Set(['田家铭', '胡佳涛', '罗子宽', '林世棋']);

      function normTitle(v) {
        return String(v || '').replace(/\s+/g, '').replace(/[【】()[\]（）]/g, '').toLowerCase();
      }

      // 选出同组中"最好"的任务：已完成 > 进度最高 > 最早创建
      function pickBest(group) {
        const done = group.find((t) => t.status === '已完成' || t.status === 'completed');
        if (done) return done;
        return group.slice().sort((a, b) => {
          const pd = (Number(b.progress) || 0) - (Number(a.progress) || 0);
          if (pd !== 0) return pd;
          return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
        })[0];
      }

      const next = await updateStore((draft) => {
        const tasks = draft.tasks || [];
        // 按 normalizeTitle 分组
        const groups = new Map();
        for (const task of tasks) {
          const key = normTitle(task.title);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(task);
        }
        const survivors = [];
        let removed = 0;
        for (const group of groups.values()) {
          const best = pickBest(group);
          survivors.push(best);
          removed += group.length - 1;
        }
        // 修正占位符 owner
        let fixedOwners = 0;
        draft.tasks = survivors.map((task) => {
          if (MEMBER_PLACEHOLDER.test(String(task.owner || '').trim())) {
            fixedOwners++;
            return { ...task, owner: '待认领' };
          }
          return task;
        });
        // 同步修正 deliverables 的 owner
        draft.deliverables = (draft.deliverables || []).map((d) => {
          if (MEMBER_PLACEHOLDER.test(String(d.owner || '').trim())) {
            return { ...d, owner: '待认领', updatedAt: new Date().toISOString() };
          }
          return d;
        });
        draft._cleanupLog = { removed, fixedOwners, survivors: survivors.length, at: new Date().toISOString() };
        return draft;
      });
      sendJson(res, 200, {
        ok: true,
        ...(next._cleanupLog || {}),
        message: `去重完成：保留 ${next._cleanupLog?.survivors} 个任务，清除 ${next._cleanupLog?.removed} 个重复，修正 ${next._cleanupLog?.fixedOwners} 个占位符 owner`
      });
      return true;
    }

    // 重置路径图：清空 deliverables/phases/checklist，保留 tasks（已完成的不丢）
    if (req.method === 'POST' && url.pathname === '/api/stage/reset-roadmap') {
      const { json } = await readBody(req);
      const projectId = json?.projectId || '';
      const next = await updateStore((draft) => {
        // 清空交付项和阶段（按项目隔离，或全清）
        draft.deliverables = projectId
          ? (draft.deliverables || []).filter((d) => d.projectId && d.projectId !== projectId)
          : [];
        draft.phases = projectId
          ? (draft.phases || []).filter((p) => p.projectId && p.projectId !== projectId)
          : [];
        // 重置 currentStage checklist 和 phases 到默认值
        draft.currentStage = {
          ...(draft.currentStage || {}),
          checklist: [],
          phases: []
        };
        // 清空 checklistOverrides（路径图手动覆盖）
        draft.checklistOverrides = {};
        // 清空语义链接缓存（与路径图强相关）
        draft.semanticLinks = {};
        return draft;
      });
      sendJson(res, 200, {
        ok: true,
        message: '路径图已重置，已完成任务已保留。请触发 sync-docs 重新生成路径图。',
        remainingTasks: (next.tasks || []).length,
        completedTasks: (next.tasks || []).filter((t) => t.status === '已完成' || t.status === 'completed').length
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/risks/scan') {
      const store = await loadStore();
      const alerts = scanRisks(store);
      const nextStore = await saveStore({ ...store, alerts });
      sendJson(res, 200, { alerts, metrics: buildMetrics(nextStore, alerts) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/plan-adjustments') {
      const store = await loadStore();
      const adjustments = (store.planAdjustments || []).slice(0, 20);
      sendJson(res, 200, { adjustments });
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/plan-adjustments/') && url.pathname.endsWith('/alternatives')) {
      const id = decodeURIComponent(url.pathname.split('/')[3] || '');
      const store = await loadStore();
      const item = (store.planAdjustments || []).find((adjustment) => adjustment.id === id);
      if (!item) { sendError(res, 404, 'not found'); return true; }
      if (item.alternatives?.length) {
        sendJson(res, 200, { alternatives: item.alternatives });
        return true;
      }
      const alternatives = await generatePlanAlternatives(item);
      await updateStore((draft) => {
        const index = (draft.planAdjustments || []).findIndex((adjustment) => adjustment.id === id);
        if (index >= 0) draft.planAdjustments[index].alternatives = alternatives;
        return draft;
      });
      sendJson(res, 200, { alternatives });
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/plan-adjustments/') && url.pathname.endsWith('/decision')) {
      const id = decodeURIComponent(url.pathname.split('/')[3] || '');
      const { json } = await readBody(req);
      const decision = String(json?.decision || '').trim();
      if (!['approved', 'rejected'].includes(decision)) {
        sendError(res, 400, 'decision must be approved or rejected');
        return true;
      }
      const decidedAt = new Date().toISOString();
      const nextStore = await updateStore((draft) => {
        const index = (draft.planAdjustments || []).findIndex((item) => item.id === id);
        if (index < 0) return draft;
        const base = draft.planAdjustments[index];
        const alternative = json?.selectedAlternative;
        const nextAdjustment = {
          ...base,
          status: decision,
          decidedAt,
          decisionNote: String(json?.note || '').trim(),
          selectedAlternativeTitle: alternative?.title || null,
          stageUpdate: (decision === 'approved' && alternative?.stageUpdate)
            ? normalizePlanStageUpdate(alternative.stageUpdate, 'major')
            : base.stageUpdate,
          appliedAt: decision === 'approved' && (alternative?.stageUpdate || base.stageUpdate)
            ? decidedAt
            : base.appliedAt
        };
        let nextDraft = draft;
        if (decision === 'approved') {
          nextDraft = applyPlanAdjustmentToStage(draft, nextAdjustment);
        }
        nextDraft.planAdjustments[index] = nextAdjustment;
        return nextDraft;
      });
      const adjustment = (nextStore.planAdjustments || []).find((item) => item.id === id);
      if (!adjustment) {
        sendError(res, 404, 'plan adjustment not found');
        return true;
      }
      sendJson(res, 200, { adjustment, adjustments: nextStore.planAdjustments || [] });
      return true;
    }

    return false;
  };
}
