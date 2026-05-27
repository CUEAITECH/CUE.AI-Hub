// ── PR 模板生成 ──────────────────────────────────────────────────────────────
function buildPrBody(task, projectName = '') {
  const acceptance = (task.acceptance || '').trim();
  const acLines = acceptance
    ? acceptance.split('\n').filter(Boolean).map((line) => {
        const stripped = line.replace(/^[-*\d.)\s]+/, '').trim();
        return stripped ? `- [ ] ${stripped}` : null;
      }).filter(Boolean).join('\n')
    : '- [ ] （验收标准待填写）';

  const hubUrl = process.env.HUB_URL || 'https://hub.cueai.top';

  return `## 关联任务
> **${task.title}** · \`${task.id}\`${task.owner && task.owner !== '待认领' ? ` · 负责人：${task.owner}` : ''}${projectName ? ` · ${projectName}` : ''}

## 验收标准 (Acceptance Criteria)

${acLines}

## 变更说明

<!-- 描述本次 PR 的主要改动 -->

## 测试方案

<!-- 如何验证上述验收标准 -->

---
*由 CUE Project Hub 自动生成 · [查看任务详情](${hubUrl})*`;
}

// 分支名安全化：只保留字母数字连字符，截断过长部分
function safeBranchName(taskId, title = '') {
  const slug = title
    .toLowerCase()
    .replace(/[一-鿿]/g, '') // 去掉中文（会导致 GitHub 分支名问题）
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `feat/${taskId}${slug ? `-${slug}` : ''}`;
}

export function createTaskRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  normalizeTask,
  estimateTasksProgress,
  generatePlan,
  createBranch,
  createDraftPR,
  parseRepo
}) {
  return async function taskRoutes(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const { json } = await readBody(req);
      if (!json || !json.title) {
        sendError(res, 400, 'title is required');
        return true;
      }

      const task = normalizeTask(json);
      const nextStore = await updateStore((store) => {
        store.tasks.unshift(task);
        return store;
      });
      sendJson(res, 201, { task, tasks: nextStore.tasks });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/tasks/ai-progress') {
      const store = await loadStore();
      const results = await estimateTasksProgress(store);
      if (!results.length) {
        sendJson(res, 200, { tasks: store.tasks, suggestions: [], message: '无关联提交，无法估算进度。' });
        return true;
      }

      const next = await updateStore((draft) => {
        for (const result of results) {
          const task = draft.tasks.find((item) => item.id === result.taskId);
          if (!task) continue;
          const newProgress = Math.max(0, Math.min(100, Number(result.progress) || 0));
          const isManualProgress = task.progressSource === 'manual' || Boolean(task.completionSource);
          const appliedProgress = isManualProgress ? Math.max(task.progress || 0, newProgress) : newProgress;
          task.progress = appliedProgress;
          task.progressSource = isManualProgress ? 'manual' : 'auto';
          task.aiProgressSuggestion = {
            progress: newProgress,
            appliedProgress,
            reason: String(result.reason || '').slice(0, 80),
            hint: String(result.hint || '').slice(0, 100),
            suggestComplete: !!result.suggestComplete,
            updatedAt: new Date().toISOString()
          };
        }
        return draft;
      });
      sendJson(res, 200, {
        tasks: next.tasks,
        suggestions: results.filter((result) => result.suggestComplete).map((result) => result.taskId)
      });
      return true;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const { json } = await readBody(req);
      const nextStore = await updateStore((store) => {
        const index = store.tasks.findIndex((task) => task.id === id);
        if (index === -1) return store;
        const manualPatch = Object.hasOwn(json || {}, 'progress')
          || Object.hasOwn(json || {}, 'status')
          || Object.hasOwn(json || {}, 'completionSource');
        store.tasks[index] = normalizeTask({
          ...store.tasks[index],
          ...json,
          id,
          createdAt: store.tasks[index].createdAt,
          progressSource: manualPatch ? 'manual' : store.tasks[index].progressSource
        });
        return store;
      });
      const task = nextStore.tasks.find((item) => item.id === id);
      if (!task) sendError(res, 404, 'task not found');
      else sendJson(res, 200, { task, tasks: nextStore.tasks });
      return true;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(url.pathname.split('/')[3] || '');
      const nextStore = await updateStore((store) => {
        store.tasks = store.tasks.filter((task) => task.id !== id);
        return store;
      });
      sendJson(res, 200, { deleted: id, tasks: nextStore.tasks });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/plans') {
      const { json } = await readBody(req);
      const store = await loadStore();
      const tasks = await generatePlan(json?.goal || '', store.members);
      sendJson(res, 200, {
        goal: json?.goal || '',
        tasks
      });
      return true;
    }

    // ── POST /api/tasks/:id/create-pr ────────────────────────────────────────
    // 为任务在关联项目仓库里创建 Draft PR（含分支），PR body 内嵌 AC checklist
    if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/create-pr$/.test(url.pathname)) {
      const taskId = decodeURIComponent(url.pathname.split('/')[3]);
      const store = await loadStore();
      const task = (store.tasks || []).find((t) => t.id === taskId);
      if (!task) { sendError(res, 404, 'task not found'); return true; }

      // 找关联项目（优先 task.projectId，其次第一个有 GitHub 配置的项目）
      const projects = store.projects || [];
      const project = projects.find((p) => p.id === task.projectId)
        || projects.find((p) => { const { owner, repo } = parseRepo(p); return owner && repo; });

      if (!project) { sendError(res, 400, '未找到关联项目，请先在项目设置里配置 GitHub 仓库'); return true; }

      const { owner, repo } = parseRepo(project);
      if (!owner || !repo) { sendError(res, 400, '项目未配置 GitHub Owner / Repository'); return true; }

      if (!createBranch || !createDraftPR) {
        sendError(res, 501, 'GitHub 写权限未配置，请确认 GITHUB_TOKEN 有 contents:write 和 pull-requests:write 权限');
        return true;
      }

      const branchName = safeBranchName(taskId, task.title);
      const prTitle = `feat(${taskId}): ${task.title}`;
      const prBody = buildPrBody(task, project.name);

      try {
        // 1. 创建分支（若已存在则忽略 422）
        let branchCreated = true;
        try {
          await createBranch(owner, repo, branchName);
        } catch (err) {
          if (err.message.includes('422') || err.message.includes('Reference already exists')) {
            branchCreated = false; // 分支已存在，继续创建 PR
          } else {
            throw err;
          }
        }

        // 2. 创建 Draft PR
        const { number: prNumber, htmlUrl } = await createDraftPR(owner, repo, {
          title: prTitle,
          body: prBody,
          head: branchName,
          base: 'main'
        });

        // 3. 把 PR 号写回 task（供 Hub 快速关联）
        const nextStore = await updateStore((draft) => {
          const t = draft.tasks.find((x) => x.id === taskId);
          if (t) {
            t.linkedPrNumber = prNumber;
            t.linkedPrBranch = branchName;
            t.updatedAt = new Date().toISOString();
          }
          return draft;
        });

        sendJson(res, 201, {
          prNumber,
          htmlUrl,
          branch: branchName,
          branchCreated,
          task: nextStore.tasks.find((t) => t.id === taskId) || task
        });
      } catch (err) {
        sendError(res, 500, `创建 PR 失败：${err.message}`);
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/plans/apply') {
      const { json } = await readBody(req);
      const plannedTasks = Array.isArray(json?.tasks) ? json.tasks : [];
      const normalized = plannedTasks.map((task) => normalizeTask(task));
      const nextStore = await updateStore((store) => {
        store.tasks = [...normalized, ...store.tasks];
        return store;
      });
      sendJson(res, 201, { tasks: nextStore.tasks, added: normalized.length });
      return true;
    }

    return false;
  };
}
