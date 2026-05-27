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

// 分支名格式：feat/MMDD-{githubLogin}-{短ID}
// 示例：feat/0527-jiaming-fzbsys
// members：store.members 数组；ownerToLogin：githubApi 导出的反查函数
function safeBranchName(taskId, ownerName = '', members = [], ownerToLogin = null) {
  // 从 taskId 尾部取 6 位随机后缀（task_xxx_fzbsys → fzbsys）
  const shortId = taskId.split('_').pop()?.slice(0, 6) || taskId.slice(-6);
  // 今天日期 MMDD（上海时区）
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const mmdd = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  // 优先：store.members 里的 githubLogin（管理员手动维护）
  // 降级：ownerToLogin(authorMap 反查)
  // 再降级：英文名直接 ascii 化
  const member = members.find((m) => m.name === ownerName);
  const login = (member?.githubLogin?.trim())
    || (ownerToLogin && ownerToLogin(ownerName))
    || ownerName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
    || 'dev';
  return `feat/${mmdd}-${login}-${shortId}`;
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
  createFileOnBranch,
  createDraftPR,
  parseRepo,
  ownerToLogin
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

      const branchName = safeBranchName(taskId, task.owner, store.members || [], ownerToLogin);
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

        // 2. 在分支上写入任务上下文文件（初始 commit，供 Cursor/Copilot 读取）
        // 不论分支是否新建都尝试写入；若文件已存在（需 SHA）则忽略，说明该分支已有 commit
        if (createFileOnBranch) {
          const hubUrl = process.env.HUB_URL || 'https://hub.cueai.top';
          const acceptance = (task.acceptance || '').trim();
          const acLines = acceptance
            ? acceptance.split('\n').filter(Boolean)
              .map((l) => `- ${l.replace(/^[-*\d.)\s]+/, '').trim()}`).join('\n')
            : '（验收标准待填写）';

          const contextContent = `# 任务上下文 · ${task.title}

> 本文件由 CUE Project Hub 自动生成，供开发者和 AI 编码助手（Cursor / Copilot）参考。

## 基本信息

| 字段 | 值 |
|------|-----|
| 任务 ID | \`${taskId}\` |
| 负责人 | ${task.owner || '待认领'} |
| 截止日期 | ${task.due || task.dueDate || '未设置'} |
| 风险等级 | ${task.risk || '未评估'} |
| Hub 任务链接 | [查看任务](${hubUrl}) |

## 任务描述

${task.description || task.signal || '暂无描述。'}

## 验收标准

${acLines}

## 开发说明

1. 在此分支（\`${branchName}\`）上进行开发
2. 完成验收标准中的每一项后，在 PR 的 checklist 中勾选对应项
3. 代码推送后 Hub 会自动触发 AI 代码审阅
4. 所有 AC 达标后 Hub 会提示可以合并
`;

          try {
            await createFileOnBranch(
              owner, repo, branchName,
              `.hub/${taskId}.md`,
              contextContent,
              `chore(${taskId}): 初始化任务上下文文件`
            );
          } catch (fileErr) {
            // 422 = 文件已存在（需要 SHA 更新），说明分支已有 commit，可以继续
            if (!fileErr.message.includes('422')) throw fileErr;
          }
        }

        // 3. 创建 Draft PR
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
