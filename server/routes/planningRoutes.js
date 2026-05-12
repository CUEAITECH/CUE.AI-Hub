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

      // 项目无关的常见缩写，不作为产品域识别符
      const COMMON_ABBREVS = new Set([
        'api', 'sdk', 'sop', 'sos', 'mvp', 'sku', 'oauth', 'jwt', 'http', 'https',
        'json', 'yaml', 'crud', 'cors', 'rest', 'cli', 'gui', 'ux', 'ui',
        'ci', 'cd', 'dev', 'prod', 'qa', 'env', 'v1', 'v2', 'mr', 'pr', 'pm'
      ]);
      function distinctTokens(text) {
        return (String(text || '').toLowerCase().match(/[a-z][a-z0-9]+/g) || [])
          .filter((t) => t.length >= 4 && !COMMON_ABBREVS.has(t));
      }
      function isTitleConsistent(taskTitle, deliverableTitle) {
        const a = distinctTokens(taskTitle);
        const b = distinctTokens(deliverableTitle);
        if (!a.length || !b.length) return true;
        const al = String(taskTitle).toLowerCase();
        const bl = String(deliverableTitle).toLowerCase();
        if (a.some((t) => bl.includes(t))) return true;
        if (b.some((t) => al.includes(t))) return true;
        return false;
      }
      function bigramTokens(text) {
        const tokens = new Set();
        const ascii = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
        ascii.forEach((t) => tokens.add(t));
        const cjk = String(text || '').match(/[一-鿿]+/g) || [];
        for (const run of cjk) {
          for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
          if (run.length === 1) tokens.add(run);
        }
        return tokens;
      }
      function jaccard(a, b) {
        const ta = bigramTokens(a); const tb = bigramTokens(b);
        if (!ta.size || !tb.size) return 0;
        let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
        return inter / (ta.size + tb.size - inter || 1);
      }
      function sharedPrefix(a, b) {
        const n = Math.min(a.length, b.length);
        let i = 0; while (i < n && a[i] === b[i]) i++; return i;
      }
      // 综合判定：精确 + 模糊包含 + 前缀+Jaccard，覆盖词序调换/变体堆积
      function isFuzzyDuplicate(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        if (Math.abs(a.length - b.length) <= 8 && (a.includes(b) || b.includes(a))) return true;
        if (sharedPrefix(a, b) >= 4 && jaccard(a, b) >= 0.3) return true;
        return false;
      }

      const next = await updateStore((draft) => {
        const tasks = draft.tasks || [];
        // 第一轮：按 normalizeTitle 精确分组
        const groups = new Map();
        for (const task of tasks) {
          const key = normTitle(task.title);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(task);
        }
        let afterExact = [];
        let removed = 0;
        for (const group of groups.values()) {
          const best = pickBest(group);
          afterExact.push(best);
          removed += group.length - 1;
        }

        // 第二轮：模糊近似去重（含子串关系）
        // 按 normTitle 长度升序排列，让更短的标题优先被认定为"主任务"
        const sorted = afterExact.slice().sort((a, b) => normTitle(a.title).length - normTitle(b.title).length);
        const fuzzyGroups = [];
        const assigned = new Set();
        for (let i = 0; i < sorted.length; i++) {
          if (assigned.has(sorted[i].id)) continue;
          const group = [sorted[i]];
          const keyA = normTitle(sorted[i].title);
          for (let j = i + 1; j < sorted.length; j++) {
            if (assigned.has(sorted[j].id)) continue;
            const keyB = normTitle(sorted[j].title);
            if (isFuzzyDuplicate(keyA, keyB)) {
              group.push(sorted[j]);
              assigned.add(sorted[j].id);
            }
          }
          assigned.add(sorted[i].id);
          fuzzyGroups.push(group);
        }
        let fuzzyRemoved = 0;
        const survivors = [];
        for (const group of fuzzyGroups) {
          const best = pickBest(group);
          survivors.push(best);
          fuzzyRemoved += group.length - 1;
        }
        removed += fuzzyRemoved;

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
        // 跨产品域绑定校正：剥离明显冲突的 task→deliverable FK（如 iPhone 任务绑到 iPad deliverable）
        let unboundCrossDomain = 0;
        const deliverableById = new Map((draft.deliverables || []).map((d) => [d.id, d]));
        draft.tasks = draft.tasks.map((task) => {
          if (!task.deliverableId) return task;
          const dlv = deliverableById.get(task.deliverableId);
          if (!dlv) return task;
          if (!isTitleConsistent(task.title, dlv.title)) {
            unboundCrossDomain++;
            return { ...task, deliverableId: null };
          }
          return task;
        });
        // 同步把 deliverable.taskIds 里被剥离的 task 清掉
        const survivingFkPairs = new Set(
          draft.tasks.filter((t) => t.deliverableId).map((t) => `${t.deliverableId}|${t.id}`)
        );
        draft.deliverables = draft.deliverables.map((d) => ({
          ...d,
          taskIds: (d.taskIds || []).filter((tid) => survivingFkPairs.has(`${d.id}|${tid}`))
        }));
        // 重置"未被认领"任务的 owner 为 待认领（LLM 建议的预填 owner 移到 suggestedOwner）
        // 判定：task.id 在 assignments 表里没出现过，且未完成
        const claimedTaskIds = new Set(
          (draft.assignments || []).filter((a) => a.taskId).map((a) => a.taskId)
        );
        let resetOwners = 0;
        draft.tasks = draft.tasks.map((task) => {
          if (task.status === '已完成' || task.status === 'completed') return task;
          if (claimedTaskIds.has(task.id)) return task; // 已被认领，owner 保持不变
          if (task.owner === '待认领' || !task.owner) return task; // 已经是待认领或空
          resetOwners++;
          return { ...task, owner: '待认领', suggestedOwner: task.suggestedOwner || task.owner };
        });
        draft._cleanupLog = { removed, fixedOwners, survivors: survivors.length, fuzzyRemoved, unboundCrossDomain, resetOwners, at: new Date().toISOString() };
        return draft;
      });
      sendJson(res, 200, {
        ok: true,
        ...(next._cleanupLog || {}),
        message: `去重完成：保留 ${next._cleanupLog?.survivors} 个任务，清除 ${next._cleanupLog?.removed} 个重复（其中模糊 ${next._cleanupLog?.fuzzyRemoved} 个），修正 ${next._cleanupLog?.fixedOwners} 个占位符 owner，剥离 ${next._cleanupLog?.unboundCrossDomain || 0} 个跨产品域错误绑定，重置 ${next._cleanupLog?.resetOwners || 0} 个未认领任务 owner 为 待认领`
      });
      return true;
    }

    // 重置路径图：清空 deliverables/phases/checklist + 可选清掉过时文档任务
    // 默认 purgeStaleTasks=true：清除"文档导入、未完成、无 commit/认领证据"的旧任务
    // 保留：已完成 / 有 commit 证据 / 已被认领 / 人工创建（无 sourceDoc）的任务
    if (req.method === 'POST' && url.pathname === '/api/stage/reset-roadmap') {
      const { json } = await readBody(req);
      const projectId = json?.projectId || '';
      const purgeStaleTasks = json?.purgeStaleTasks !== false; // 默认 true
      const inProject = (item) => !projectId || !item?.projectId || item.projectId === projectId;
      const next = await updateStore((draft) => {
        // 清空交付项和阶段（按项目隔离，或全清）
        draft.deliverables = projectId
          ? (draft.deliverables || []).filter((d) => d.projectId && d.projectId !== projectId)
          : [];
        draft.phases = projectId
          ? (draft.phases || []).filter((p) => p.projectId && p.projectId !== projectId)
          : [];
        // 重置 currentStage checklist 和 phases 到空
        draft.currentStage = {
          ...(draft.currentStage || {}),
          checklist: [],
          phases: []
        };
        // 清空 checklistOverrides（路径图手动覆盖）
        draft.checklistOverrides = {};
        // 清空语义链接缓存（与路径图强相关）
        draft.semanticLinks = {};
        // 清空 sync-docs 缓存，让下次 sync-docs 完全重新解析
        if (draft.docTasks && projectId) {
          delete draft.docTasks[projectId];
        } else if (!projectId) {
          draft.docTasks = {};
        }
        // 关键：剥离 tasks/activities/assignments 上的孤儿 deliverableId，
        // 否则旧 FK 会绑到下次 sync-docs 新建的同名 deliverable 上，造成跨节点污染
        let strippedTasks = 0;
        draft.tasks = (draft.tasks || []).map((task) => {
          if (inProject(task) && task.deliverableId) {
            strippedTasks++;
            return { ...task, deliverableId: null };
          }
          return task;
        });
        draft.activities = (draft.activities || []).map((activity) => (
          inProject(activity) && activity.deliverableId
            ? { ...activity, deliverableId: null }
            : activity
        ));
        draft.assignments = (draft.assignments || []).map((assignment) => (
          inProject(assignment) && assignment.deliverableId
            ? { ...assignment, deliverableId: null }
            : assignment
        ));
        // 清理过时文档任务：用户改了目标仓库文档后，旧任务在 hub 累积，需要主动淘汰
        // 保留规则：已完成 / 有 commit 证据 / 已被认领 / 人工创建（无 sourceDoc）→ 都不删
        let purgedStale = 0;
        if (purgeStaleTasks) {
          const isCompleted = (t) => t.status === '已完成' || t.status === 'completed';
          const taskIdsWithCommitEvidence = new Set(
            (draft.activities || [])
              .filter((a) => inProject(a) && a.type === 'commit' && a.taskId)
              .map((a) => a.taskId)
          );
          const taskIdsWithAssignment = new Set(
            (draft.assignments || []).filter((a) => inProject(a) && a.taskId).map((a) => a.taskId)
          );
          draft.tasks = (draft.tasks || []).filter((task) => {
            if (!inProject(task)) return true;
            if (isCompleted(task)) return true;
            if (taskIdsWithCommitEvidence.has(task.id)) return true;
            if (taskIdsWithAssignment.has(task.id)) return true;
            if (!task.sourceDoc) return true; // 人工创建（不来自文档），保留
            // 剩下的：未完成 + 无证据 + 无认领 + 文档导入 → 视为旧文档遗留，删除
            purgedStale++;
            return false;
          });
        }
        draft._resetLog = { strippedTasks, purgedStale, at: new Date().toISOString() };
        return draft;
      });
      sendJson(res, 200, {
        ok: true,
        message: `路径图已重置。剥离 ${next._resetLog?.strippedTasks || 0} 个旧绑定，清理 ${next._resetLog?.purgedStale || 0} 个过时文档任务（已完成/有证据/已认领的全部保留）。`,
        remainingTasks: (next.tasks || []).length,
        completedTasks: (next.tasks || []).filter((t) => t.status === '已完成' || t.status === 'completed').length,
        strippedBindings: next._resetLog?.strippedTasks || 0,
        purgedStaleTasks: next._resetLog?.purgedStale || 0
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
