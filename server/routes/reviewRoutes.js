function reviewSha(review) {
  return review.sha || (review.id?.startsWith('review_') ? review.id.slice(7) : null);
}

export function createReviewRoutes({
  createId,
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  reviewChange,
  fetchCommitDetail,
  callClaude,
  parseJsonOutput
}) {
  return async function reviewRoutes(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/reviews') {
      const { json } = await readBody(req);
      const review = {
        id: createId('review'),
        humanDecision: null,
        ...await reviewChange(json || {})
      };
      const nextStore = await updateStore((store) => {
        store.reviews.unshift(review);
        return store;
      });
      sendJson(res, 201, { review, reviews: nextStore.reviews });
      return true;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/reviews/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const { json } = await readBody(req);

      // 新格式：decision + reason + overrideBlock + overrideReason
      // 向后兼容：旧格式 humanDecision string（'acknowledged'|'needs-fix'|'exempted'）
      const isNewFormat = ['LGTM', 'request_changes', 'waiting'].includes(json?.decision);
      const isLegacyFormat = ['acknowledged', 'needs-fix', 'exempted'].includes(json?.humanDecision);

      // override Block 时，overrideReason 必填
      if (isNewFormat && json?.overrideBlock && !String(json?.overrideReason || '').trim()) {
        sendError(res, 400, 'overrideReason 为必填项（覆盖 Block 决定需记录理由）');
        return true;
      }

      let updated = null;
      await updateStore((draft) => {
        const index = (draft.reviews || []).findIndex((review) => review.id === id);
        if (index === -1) return draft;
        const existing = draft.reviews[index];

        let humanDecision;
        if (isNewFormat) {
          const decisionStatusMap = { LGTM: 'approved', request_changes: 'requested_changes', waiting: 'waiting' };
          humanDecision = {
            status: decisionStatusMap[json.decision],
            reviewer: json?.reviewer || '',
            reason: String(json?.reason || '').trim(),
            overrideBlock: Boolean(json?.overrideBlock),
            overrideReason: String(json?.overrideReason || '').trim(),
            timestamp: new Date().toISOString()
          };
          // 同步更新 blocks 的 isOverridden 标记
          if (json?.overrideBlock && Array.isArray(existing.blocks)) {
            const updatedBlocks = existing.blocks.map((b) => ({ ...b, isOverridden: true }));
            draft.reviews[index] = { ...existing, blocks: updatedBlocks };
          }
        } else if (isLegacyFormat) {
          // 向后兼容旧格式，转换为对象结构
          const legacyMap = { acknowledged: 'approved', 'needs-fix': 'requested_changes', exempted: 'approved' };
          humanDecision = {
            status: legacyMap[json.humanDecision] || 'approved',
            reviewer: '',
            reason: String(json?.humanNote || '').trim(),
            overrideBlock: json.humanDecision === 'exempted',
            overrideReason: json.humanDecision === 'exempted' ? String(json?.humanNote || '').trim() : '',
            timestamp: new Date().toISOString()
          };
        } else {
          return draft; // 格式不合法，不更新
        }

        updated = {
          ...existing,
          humanDecision,
          // 保留旧字段向后兼容（供现有前端读取）
          humanNote: String(json?.reason || json?.humanNote || '').trim() || existing.humanNote || '',
          humanAt: new Date().toISOString()
        };
        draft.reviews[index] = updated;
        return draft;
      });
      if (!updated) { sendError(res, 404, 'review not found'); return true; }
      sendJson(res, 200, { review: updated });
      return true;
    }

    if (req.method === 'GET' && url.pathname.match(/^\/api\/reviews\/[^/]+$/) && url.pathname !== '/api/reviews/queue') {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const store = await loadStore();
      const review = (store.reviews || []).find((item) => item.id === id);
      if (!review) { sendError(res, 404, 'review not found'); return true; }

      let diff = null;
      const sha = reviewSha(review);
      if (sha && review.repo) {
        const [repoOwner, repoName] = review.repo.split('/');
        if (repoOwner && repoName) {
          try {
            const detail = await fetchCommitDetail(repoOwner, repoName, sha);
            diff = (detail?.files || [])
              .slice(0, 10)
              .map((file) => `--- ${file.filename}\n${file.patch || '(binary or no patch)'}`)
              .join('\n\n');
          } catch { /* 无法获取 diff，静默跳过 */ }
        }
      }
      sendJson(res, 200, { review, diff });
      return true;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/reviews\/[^/]+\/solutions$/)) {
      const id = decodeURIComponent(url.pathname.split('/').slice(-2)[0]);
      const store = await loadStore();
      const review = (store.reviews || []).find((item) => item.id === id);
      if (!review) { sendError(res, 404, 'review not found'); return true; }

      if (review.solutions) {
        sendJson(res, 200, { solutions: review.solutions });
        return true;
      }

      const systemPrompt = `你是资深代码审阅专家。根据 AI 代码审阅的问题，给出 2-3 个具体可执行的解决方案。
每个方案必须包含：
- title: 方案标题（10字以内）
- detail: 具体操作步骤（50-100字）
- effort: 预计工作量（轻量/中等/较大）
- recommended: 是否为推荐方案（true/false，只能有一个true）

返回 JSON 数组格式。`;
      const userPrompt = `提交：${review.title}
作者：${review.owner}
审阅结论：${review.level}
AI 发现的问题：
${(review.findings || []).map((finding, index) => `${index + 1}. ${finding}`).join('\n')}
AI 建议：${review.suggestion || '无'}`;

      const raw = await callClaude(systemPrompt, userPrompt);
      const solutions = parseJsonOutput(raw);
      const finalSolutions = Array.isArray(solutions) ? solutions.slice(0, 3) : [
        { title: '立即修复', detail: '根据 AI 发现的问题逐项修复，提交新的 commit 并重新触发审阅。', effort: '中等', recommended: true },
        { title: '豁免处理', detail: '评估后认为该问题不影响生产，记录豁免理由并在下次迭代中优化。', effort: '轻量', recommended: false }
      ];

      await updateStore((draft) => {
        const index = (draft.reviews || []).findIndex((item) => item.id === id);
        if (index >= 0) draft.reviews[index].solutions = finalSolutions;
        return draft;
      });

      sendJson(res, 200, { solutions: finalSolutions });
      return true;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/reviews\/[^/]+\/resolve$/)) {
      const id = decodeURIComponent(url.pathname.split('/').slice(-2)[0]);
      const { json } = await readBody(req);
      const store = await loadStore();
      const review = (store.reviews || []).find((item) => item.id === id);
      if (!review) { sendError(res, 404, 'review not found'); return true; }

      const { decision, solution, solutionTitle, assignee } = json || {};
      if (!['pass', 'needs-fix'].includes(decision)) {
        sendError(res, 400, 'decision must be pass or needs-fix');
        return true;
      }

      let createdTask = null;
      if (decision === 'needs-fix' && solution) {
        createdTask = {
          id: createId('task'),
          title: `[审阅修复] ${solutionTitle || review.title.slice(0, 30)}`,
          description: `来源：AI 代码审阅 ${review.shortSha || review.id}\n提交：${review.title}\n作者：${review.owner}\n\n选定方案：${solution}`,
          owner: assignee || review.owner || '未分配',
          status: '进行中',
          risk: review.level === 'Escalate' ? '高' : '中',
          progress: 0,
          reviewId: id,
          repo: review.repo || null,
          projectId: review.projectId || 'cue_ai_classroom',
          createdAt: new Date().toISOString()
        };
      }

      let updatedReview;
      await updateStore((draft) => {
        const index = (draft.reviews || []).findIndex((item) => item.id === id);
        if (index >= 0) {
          updatedReview = {
            ...draft.reviews[index],
            humanDecision: decision === 'pass' ? 'exempted' : 'needs-fix',
            humanNote: solution || '',
            humanAt: new Date().toISOString(),
            resolvedTaskId: createdTask?.id || null
          };
          draft.reviews[index] = updatedReview;
        }
        if (createdTask) {
          draft.tasks = [createdTask, ...(draft.tasks || [])];
        }
        return draft;
      });

      sendJson(res, 200, { review: updatedReview, task: createdTask });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/reviews/queue') {
      const store = await loadStore();
      const allReviews = store.reviews || [];
      const tasks = store.tasks || [];

      // 完成度分层过滤：< 50% 不进队列（太早，让作者继续迭代）
      const eligible = allReviews.filter((review) => {
        const rate = review.completionRate;
        return rate === null || rate === undefined || rate >= 50;
      });

      const pending = eligible.filter(
        (review) => (review.level === 'Block' || review.level === 'Escalate') && !review.humanDecision
      );
      const recent = eligible.filter((review) => {
        if (review.humanDecision) return false;
        if (review.level === 'Block' || review.level === 'Escalate') return false;
        if (review.level === 'Pass') return false;
        return true;
      });

      // 关联 task spec
      const enrich = (review) => {
        const linkedTask = review.compliance?.taskId
          ? tasks.find((t) => t.id === review.compliance.taskId)
          : null;
        return {
          ...review,
          linkedTask: linkedTask ? {
            id: linkedTask.id,
            title: linkedTask.title,
            description: linkedTask.description || '',
            owner: linkedTask.owner || ''
          } : null
        };
      };

      const queue = [
        ...pending.sort((a, b) => (b.level === 'Block') - (a.level === 'Block')),
        ...recent.slice(0, 30)
      ].map(enrich);

      sendJson(res, 200, {
        queue,
        pendingCount: pending.length,
        recentCount: recent.length,
        generatedAt: new Date().toISOString()
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/reviews/queue/detailed') {
      const store = await loadStore();
      const allReviews = store.reviews || [];
      const tasks = store.tasks || [];

      // 与 /queue 一致的过滤逻辑，但返回完整 AI 报告 + task spec
      const eligible = allReviews.filter((review) => {
        const rate = review.completionRate;
        return rate === null || rate === undefined || rate >= 50;
      });

      const pending = eligible.filter(
        (review) => (review.level === 'Block' || review.level === 'Escalate') && !review.humanDecision
      );
      const recent = eligible.filter((review) => {
        if (review.humanDecision) return false;
        if (review.level === 'Block' || review.level === 'Escalate') return false;
        if (review.level === 'Pass') return false;
        return true;
      });

      const enrich = (review) => {
        const linkedTask = review.compliance?.taskId
          ? tasks.find((t) => t.id === review.compliance.taskId)
          : null;
        return {
          ...review,
          linkedTask: linkedTask || null,
          // 完成度分层标签
          completionLabel: (review.completionRate !== null && review.completionRate !== undefined)
            ? (review.completionRate >= 90 ? `${review.completionRate}% — AI PASS 可合并`
              : review.completionRate >= 50 ? `${review.completionRate}% — 待人工审阅`
              : `${review.completionRate}% — 太早，继续迭代`)
            : '完成度未计算'
        };
      };

      const queue = [
        ...pending.sort((a, b) => (b.level === 'Block') - (a.level === 'Block')),
        ...recent.slice(0, 30)
      ].map(enrich);

      sendJson(res, 200, {
        queue,
        pendingCount: pending.length,
        recentCount: recent.length,
        generatedAt: new Date().toISOString()
      });
      return true;
    }

    return false;
  };
}
