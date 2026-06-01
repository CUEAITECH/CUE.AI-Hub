import { getTenantId } from '../services/auth.js';
export function createPullRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  mergePR,
  getBranchProtection,
  parseRepo,
  sendWeComMarkdown,
  isWeComAvailable,
  hubUrl
}) {
  /**
   * 判断 pull 是否满足合并条件
   * @param {object} pull - store.pulls 中的 pull 条目
   * @param {object} review - pull.hubReview 对象
   * @returns {{ ok: boolean, reason: string }}
   */
  function checkMergeReady(pull, review) {
    if (pull.state === 'merged') return { ok: false, reason: '已经合并' };
    if (pull.state !== 'open') return { ok: false, reason: `PR 状态为 ${pull.state}，无法合并` };

    const humanDecision = review?.humanDecision;
    const aiLevel = review?.level;

    // 人工已 LGTM 或 AI Pass（completionRate >= 90）
    const humanApproved = humanDecision?.status === 'approved'
      || humanDecision === 'exempted' // 旧格式向后兼容
      || humanDecision === 'acknowledged';
    const aiAutoPass = aiLevel === 'Pass' && (review?.completionRate ?? 0) >= 90;

    if (!humanApproved && !aiAutoPass) {
      return { ok: false, reason: '需要人工 LGTM 或 AI Pass（完成度 ≥ 90%）才可合并' };
    }

    // 有 Block 项但未 override
    const unresolved = (review?.blocks || []).filter((b) => !b.isOverridden);
    if (unresolved.length) {
      return { ok: false, reason: `有 ${unresolved.length} 个 Block 风险项未处理` };
    }

    return { ok: true, reason: '准备合并' };
  }

  return async function pullRoutes(req, res, url) {
    // GET /api/pulls  — 列表（支持 ?projectId=&state=&author= 筛选）
    if (req.method === 'GET' && url.pathname === '/api/pulls') {
      const store = await loadStore(getTenantId(req));
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
      const store = await loadStore(getTenantId(req));
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
      }, getTenantId(req));

      if (!updated) { sendError(res, 404, 'pull not found'); return true; }
      sendJson(res, 200, { pull: updated });
      return true;
    }

    // POST /api/pulls/:id/merge — 任务负责人手动触发合并
    if (req.method === 'POST' && url.pathname.match(/^\/api\/pulls\/[^/]+\/merge$/)) {
      const id = decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]);
      const { json } = await readBody(req);
      const store = await loadStore(getTenantId(req));

      const pull = (store.pulls || []).find((p) => p.id === id);
      if (!pull) { sendError(res, 404, 'pull not found'); return true; }

      const review = pull.hubReview || null;
      const { ok, reason } = checkMergeReady(pull, review);
      if (!ok) { sendError(res, 422, reason); return true; }

      // 找出关联的 project，以获取 owner/repo
      const project = (store.projects || []).find((p) => p.id === pull.projectId);
      if (!project) { sendError(res, 422, '找不到项目配置，无法获取 GitHub owner/repo'); return true; }
      const { owner, repo } = parseRepo(project);
      if (!owner || !repo) { sendError(res, 422, '项目未配置 GitHub 仓库信息'); return true; }

      // 调用 GitHub Merge API
      let mergeResult;
      try {
        mergeResult = await mergePR(owner, repo, pull.number, {
          commit_title: `${pull.title} (#${pull.number})`,
          commit_message: json?.message || '',
          merge_method: json?.method || 'squash'
        });
      } catch (err) {
        sendError(res, 502, `GitHub 合并失败：${err.message}`);
        return true;
      }

      // 更新 store：pull.state = merged + 关联 task 状态
      const actor = json?.actor || '';
      let mergedTask = null;
      await updateStore((draft) => {
        const pullIdx = (draft.pulls || []).findIndex((p) => p.id === id);
        if (pullIdx !== -1) {
          draft.pulls[pullIdx] = {
            ...draft.pulls[pullIdx],
            state: 'merged',
            mergedAt: new Date().toISOString(),
            mergedBy: actor,
            updatedAt: new Date().toISOString()
          };
        }
        // 关联 task：如有，更新状态为已完成
        const taskIds = pull.linkedTaskIds || [];
        for (const taskId of taskIds) {
          const taskIdx = (draft.tasks || []).findIndex((t) => t.id === taskId);
          if (taskIdx !== -1 && draft.tasks[taskIdx].status !== '已完成') {
            draft.tasks[taskIdx] = {
              ...draft.tasks[taskIdx],
              status: '已完成',
              progress: 100,
              completedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
            mergedTask = draft.tasks[taskIdx];
          }
        }
        return draft;
      }, getTenantId(req));

      // 企微推送
      if (isWeComAvailable && isWeComAvailable()) {
        const taskInfo = mergedTask ? `\n> 任务：${mergedTask.title} → 已完成` : '';
        const msg = `### ✅ PR 已合并\n> **${pull.title}** (#${pull.number})\n> 仓库：${owner}/${repo}${taskInfo}\n> 合并人：${actor || '系统'}\n> 时间：${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}\n\n[查看 Hub](${hubUrl || 'https://hub.cueai.top'})`;
        sendWeComMarkdown(msg).catch(() => {});
      }

      sendJson(res, 200, { merged: true, sha: mergeResult?.sha, pull: { id, state: 'merged' }, task: mergedTask });
      return true;
    }

    // POST /api/pulls/:id/auto-merge-check — 检查是否满足自动合并条件（autonomousMode 任务专用）
    if (req.method === 'POST' && url.pathname.match(/^\/api\/pulls\/[^/]+\/auto-merge-check$/)) {
      const id = decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]);
      const store = await loadStore(getTenantId(req));

      const pull = (store.pulls || []).find((p) => p.id === id);
      if (!pull) { sendError(res, 404, 'pull not found'); return true; }

      const review = pull.hubReview || null;
      const linkedTasks = (pull.linkedTaskIds || []).map((tid) =>
        (store.tasks || []).find((t) => t.id === tid)
      ).filter(Boolean);

      // autonomousMode 任务检查
      const isAutonomous = linkedTasks.some((t) => t.autonomousMode === true);
      if (!isAutonomous) {
        sendJson(res, 200, { eligible: false, reason: '关联任务不是 autonomousMode，跳过自动合并' });
        return true;
      }

      const { ok, reason } = checkMergeReady(pull, review);
      if (!ok) {
        sendJson(res, 200, { eligible: false, reason });
        return true;
      }

      // 检查 GitHub branch protection（CI 是否通过）
      const project = (store.projects || []).find((p) => p.id === pull.projectId);
      if (project && getBranchProtection && parseRepo) {
        const { owner, repo } = parseRepo(project);
        if (owner && repo) {
          try {
            const protection = await getBranchProtection(owner, repo, pull.baseBranch || 'main');
            const required = protection?.required_status_checks?.contexts || [];
            if (required.length > 0) {
              // 有 CI 要求但无法在这里验证 check runs，只报告 pending
              sendJson(res, 200, { eligible: false, reason: `需等待 CI 检查完成（${required.join(', ')}）` });
              return true;
            }
          } catch {
            // 无保护规则，跳过 CI 检查
          }
        }
      }

      sendJson(res, 200, { eligible: true, reason: '满足自动合并条件' });
      return true;
    }

    return false;
  };
}
