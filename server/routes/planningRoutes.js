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
