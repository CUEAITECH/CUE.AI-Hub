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
      const allowed = ['acknowledged', 'needs-fix', 'exempted'];
      const decision = allowed.includes(json?.humanDecision) ? json.humanDecision : null;
      let updated = null;
      await updateStore((draft) => {
        const index = (draft.reviews || []).findIndex((review) => review.id === id);
        if (index === -1) return draft;
        updated = {
          ...draft.reviews[index],
          humanDecision: decision,
          humanNote: String(json?.humanNote || '').trim() || draft.reviews[index].humanNote || '',
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
          projectId: 'cue_ai_classroom',
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
      const pending = allReviews.filter(
        (review) => (review.level === 'Block' || review.level === 'Escalate') && !review.humanDecision
      );
      const recent = allReviews.filter((review) => {
        if (review.humanDecision) return false;
        if (review.level === 'Block' || review.level === 'Escalate') return false;
        if (review.level === 'Pass') return false;
        return true;
      });
      const queue = [
        ...pending.sort((a, b) => (b.level === 'Block') - (a.level === 'Block')),
        ...recent.slice(0, 30)
      ];
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
