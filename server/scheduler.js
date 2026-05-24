import logger from './logger.js';
export function startScheduler(deps) {
  const {
    loadStore,
    updateStore,
    createId,
    syncGitHubProjectIntoStore,
    hasGitHubConfig,
    generateEveningReport,
    buildProgressMarkdown,
    writeProgressToGitHub,
    importDocsForProject,
    refreshAnalysisIntoStore,
    generateDailyTaskSuggestions,
    isWeComAvailable,
    sendWeComMarkdown,
    todayText,
    isCompanyWorkday,
    githubSyncIntervalMinutes,
    githubSyncLimit,
    githubSyncDiffLimit,
    meetingHour,
    hubUrl,
    wecomBotName = 'CUE项目中枢'
  } = deps;

  let lastEveningReportDate = '';
  let lastReviewQueueDate = '';
  let lastTaskCompletionPromptDate = '';
  let lastMeetingAttendancePromptDate = '';
  let lastMeetingAbsenceCloseDate = '';
  let githubSyncRunning = false;
  const prepHour = meetingHour === 0 ? 23 : meetingHour - 1;
  const prepMinute = 45;
  const reviewHour = meetingHour <= 1 ? meetingHour + 22 : meetingHour - 2;

  async function syncGitHubProjects() {
    if (githubSyncIntervalMinutes <= 0 || githubSyncRunning) return;
    githubSyncRunning = true;
    try {
      const store = await loadStore();
      const projects = (store.projects || []).filter((project) => hasGitHubConfig(project));
      for (const project of projects) {
        try {
          const result = await syncGitHubProjectIntoStore(project, {
            since: '7 days ago',
            limit: githubSyncLimit,
            diffLimit: githubSyncDiffLimit
          });
          if (result.addedActivities || result.addedReviews) {
            logger.info(`[Scheduler] GitHub 已同步 ${project.githubFullRepo || project.repository}：新增 ${result.addedActivities} 条提交，新增 ${result.addedReviews} 条 Review`);
          }
        } catch (err) {
          logger.error(`[Scheduler] GitHub 同步失败 ${project.githubFullRepo || project.repository || project.id}:`, err.message);
        }
      }
    } finally {
      githubSyncRunning = false;
    }
  }

  if (githubSyncIntervalMinutes > 0) {
    setTimeout(syncGitHubProjects, 15_000);
    setInterval(syncGitHubProjects, githubSyncIntervalMinutes * 60_000);
  }

  setInterval(async () => {
    const now = new Date();
    const shanghaiParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).formatToParts(now);
    const sh = Number(shanghaiParts.find((p) => p.type === 'hour')?.value ?? -1);
    const sm = Number(shanghaiParts.find((p) => p.type === 'minute')?.value ?? -1);
    const today = todayText();
    const isWorkday = isCompanyWorkday(today);

    if (isWorkday && sh === 17 && sm === 0 && lastTaskCompletionPromptDate !== today) {
      lastTaskCompletionPromptDate = today;
      if (isWeComAvailable()) {
        await sendWeComMarkdown([
          `## ${today} 今日任务完成确认`,
          '',
          `请在 17:00-18:00 之间 @${wecomBotName} 回复：`,
          '- 姓名正常完成',
          '- 姓名延迟完成',
          '',
          `示例：@${wecomBotName} 林世棋正常完成`,
          '',
          '延迟完成默认要求第二个工作日补齐；如果后续请假，系统会把连续工作日作为一个评分窗口取平均。'
        ].join('\n')).catch((err) =>
          logger.error('[Scheduler] 任务完成确认推送失败', err.message)
        );
      }
    }

    if (isWorkday && sh === 18 && sm === 0 && lastMeetingAttendancePromptDate !== today) {
      lastMeetingAttendancePromptDate = today;
      if (isWeComAvailable()) {
        await sendWeComMarkdown([
          `## ${today} 晚会出席确认`,
          '',
          `请在 18:25 前 @${wecomBotName} 回复：`,
          '- 姓名正常出席',
          '- 姓名延迟出席',
          '',
          `示例：@${wecomBotName} 林世棋正常出席`,
          '',
          '18:25-18:35 回复按临时请假/迟到处理；18:35 后仍无记录默认缺勤，可由人事管理补录。'
        ].join('\n')).catch((err) =>
          logger.error('[Scheduler] 晚会出席确认推送失败', err.message)
        );
      }
    }

    if (isWorkday && sh === 18 && sm === 35 && lastMeetingAbsenceCloseDate !== today) {
      lastMeetingAbsenceCloseDate = today;
      await updateStore((draft) => {
        const projectIds = (draft.projects || []).map((project) => project.id || 'cue_ai_classroom');
        const existing = new Set((draft.attendanceRecords || [])
          .filter((item) => item.date === today && item.kind === 'meeting')
          .map((item) => `${item.projectId || 'cue_ai_classroom'}|${item.owner}`));
        draft.attendanceRecords = draft.attendanceRecords || [];
        for (const projectId of projectIds) {
          const members = new Set([
            ...(draft.members || []).map((member) => member.name).filter(Boolean),
            ...(draft.users || [])
              .filter((user) => user.role !== 'admin' && user.active !== false && ((user.projectIds || []).includes('*') || (user.projectIds || []).includes(projectId)))
              .map((user) => user.name || user.username)
              .filter(Boolean)
          ]);
          for (const owner of members) {
            const key = `${projectId}|${owner}`;
            if (existing.has(key)) continue;
            draft.attendanceRecords.unshift({
              id: createId('attendance'),
              projectId,
              date: today,
              owner,
              kind: 'meeting',
              status: 'absent',
              source: 'auto',
              editedBy: 'system',
              rawMessage: '',
              note: '18:35 前无有效晚会出席确认',
              recordedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
          }
        }
        draft.attendanceRecords = draft.attendanceRecords.slice(0, 2000);
        return draft;
      }).catch((err) => logger.error('[Scheduler] 晚会缺勤自动收口失败', err.message));
    }

    if (isWorkday && sh === prepHour && sm === prepMinute && lastEveningReportDate !== today) {
      lastEveningReportDate = today;
      logger.info(`[Scheduler] ${prepHour}:${String(prepMinute).padStart(2, '0')} 触发晚会前作战包生成...`);
      await generateEveningReport(today).catch((err) =>
        logger.error('[Scheduler] 作战包生成失败:', err.message)
      );

      // 17:45 AI 语义分析刷新（兜底：无论当天 GitHub 同步是否触发过，都保证晚会前是最新的）
      try {
        await refreshAnalysisIntoStore();
        logger.info('[Scheduler] AI 语义分析刷新完成');
      } catch (err) {
        logger.error('[Scheduler] AI 语义分析失败:', err.message);
      }

      // 晚报生成前刷新候选任务（sync-docs 轻量版）：
      // 为每个有 GitHub 配置的项目拉取最新 docs/ 并把候选任务导入 hub 任务板，
      // 保证晚会开始时（18:00）任务板有可领取任务。
      try {
        const syncStore = await loadStore();
        const syncProjects = (syncStore.projects || []).filter((p) => hasGitHubConfig(p));
        for (const project of syncProjects) {
          try {
            const result = await importDocsForProject(project, project.id);
            if (result.imported > 0) {
              logger.info(`[Scheduler] sync-docs ${project.githubFullRepo}：新增任务 ${result.imported}，候选 ${result.selected || 0}，phases ${result.phases || 0}，新建 deliverable ${result.createdDeliverables || 0}`);
            }
          } catch (err) {
            logger.error(`[Scheduler] sync-docs 失败 ${project.id}:`, err.message);
          }
        }
      } catch (err) {
        logger.error('[Scheduler] 批量 sync-docs 失败:', err.message);
      }

      // 晚报生成后，自动把进度写回 GitHub（update-docs）
      // 条件：项目有 GitHub 配置 + 之前做过 sync-docs（docTasks 非空）
      try {
        const freshStore = await loadStore();
        const docsProjects = (freshStore.projects || []).filter(
          (p) => hasGitHubConfig(p) && Array.isArray(freshStore.docTasks?.[p.id]) && freshStore.docTasks[p.id].length > 0
        );
        for (const project of docsProjects) {
          try {
            const [owner, repo] = (project.githubFullRepo || '').split('/');
            if (!owner || !repo) continue;
            const hubTasks = (freshStore.tasks || []).filter((t) => t.projectId === project.id);
            const todayAssignments = (freshStore.assignments || []).filter(
              (a) => a.date === today && hubTasks.some((t) => t.id === a.taskId)
            );
            const deliverables = (freshStore.deliverables || []).filter((d) => d.projectId === project.id);
            const markdown = buildProgressMarkdown(
              project,
              freshStore.docTasks[project.id],
              hubTasks,
              todayAssignments,
              today,
              deliverables
            );
            await writeProgressToGitHub(owner, repo, markdown);
            logger.info(`[Scheduler] 进度文档已写回 ${project.githubFullRepo}`);
          } catch (err) {
            logger.error(`[Scheduler] update-docs 失败 ${project.id}:`, err.message);
          }
        }
      } catch (err) {
        logger.error('[Scheduler] 批量 update-docs 失败:', err.message);
      }

      // 17:45 为所有活跃用户预生成明日推荐（独立 LLM 调用，per-user）
      try {
        const recStore = await loadStore();
        // forDate = 明天，为晚会后明天的工作做准备
        const tomorrow = (() => {
          const d = new Date(Date.now() + 24 * 3600 * 1000);
          const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
          }).formatToParts(d);
          const get = (t) => parts.find((p) => p.type === t)?.value;
          return `${get('year')}-${get('month')}-${get('day')}`;
        })();
        const activeUsers = (recStore.users || []).filter(
          (u) => u.active !== false && u.role !== 'admin'
        );
        let ok = 0;
        let failed = 0;
        for (const user of activeUsers) {
          try {
            const result = await generateDailyTaskSuggestions(tomorrow, user.id, recStore, { triggeredBy: 'scheduler' });
            await updateStore((draft) => {
              draft.dailyTaskSuggestions = draft.dailyTaskSuggestions || {};
              draft.dailyTaskSuggestions[tomorrow] = draft.dailyTaskSuggestions[tomorrow] || {};
              draft.dailyTaskSuggestions[tomorrow][user.id] = {
                generatedAt: new Date().toISOString(),
                generatedBy: 'scheduler',
                pool: result.pool,
                candidates: result.candidates
              };
              return draft;
            });
            ok++;
          } catch (err) {
            failed++;
            logger.error(`[Scheduler] 推荐生成失败 ${user.username || user.id}:`, err.message);
          }
        }
        logger.info(`[Scheduler] 推荐已生成：${ok} 个用户，${failed} 个失败（forDate=${tomorrow}）`);
        if (failed > 0 && isWeComAvailable()) {
          await sendWeComMarkdown([
            `## ⚠️ AI 推荐生成部分失败`,
            ``,
            `成功 ${ok} 人，失败 ${failed} 人（forDate=${tomorrow}）`,
            ``,
            `检查 OPENAI_API_KEY 配置或服务可用性。`
          ].join('\n')).catch((e) => logger.error('[Scheduler] 推荐失败告警推送失败:', e.message));
        }
      } catch (err) {
        logger.error('[Scheduler] 批量推荐生成失败:', err.message);
      }
    }

    // 晚会前 2h（reviewHour:00）推送人工审阅待办提醒
    if (isWorkday && sh === reviewHour && sm === 0 && lastReviewQueueDate !== today) {
      lastReviewQueueDate = today;
      if (isWeComAvailable()) {
        const store = await loadStore();
        const allReviews = store.reviews || [];
        const pending = allReviews.filter(
          (r) => (r.level === 'Block' || r.level === 'Escalate') && !r.humanDecision
        );
        const cutoff = Date.now() - 48 * 3600 * 1000;
        const warning = allReviews.filter((r) => {
          if (r.humanDecision || r.level === 'Block' || r.level === 'Escalate' || r.level === 'Pass') return false;
          return new Date(r.createdAt || 0).getTime() >= cutoff;
        });
        if (pending.length || warning.length) {
          const lines = [
            `## 📋 人工审阅提醒（晚会前 ${meetingHour - reviewHour}h）`,
            '',
            pending.length
              ? `**Block/Escalate 待处理（${pending.length} 条）：**\n${pending.slice(0, 5).map((r) => `- [${r.level}] ${r.owner || '未知'}：${r.title}`).join('\n')}`
              : '✅ 无 Block/Escalate 阻断项',
            '',
            warning.length
              ? `**近 48h Warning 待确认（${warning.length} 条）：**\n${warning.slice(0, 5).map((r) => `- ${r.owner || '未知'}：${r.title}`).join('\n')}`
              : '',
            '',
            `[前往人工审阅](${hubUrl}#reviews)`
          ].filter((l) => l !== undefined).join('\n');
          await sendWeComMarkdown(lines).catch((err) =>
            logger.error('[Scheduler] 人工审阅提醒推送失败:', err.message)
          );
          logger.info(`[Scheduler] ${reviewHour}:00 已推送人工审阅提醒（${pending.length} Block/Escalate，${warning.length} Warning）`);
        }
      }
    }
  }, 60_000);

  // 每小时检查 C+ bypass 是否超期（24h 内未补 PR）
  async function checkBypassDeadlines() {
    if (!isWeComAvailable()) return;
    try {
      const store = await loadStore();
      const overdueBypass = (store.bypasses || []).filter((bypass) => {
        if (bypass.prLinked || bypass.alertSent) return false;
        return new Date(bypass.deadline).getTime() < Date.now();
      });
      if (!overdueBypass.length) return;
      const lines = [
        `## ⚠️ C+ bypass 超期提醒（${overdueBypass.length} 条）`,
        '',
        ...overdueBypass.slice(0, 5).map((b) => `- **${b.author || '未知'}** hotfix commit \`${b.sha.slice(0, 7)}\`（${b.branch}）超过 24h 未补 PR`),
        '',
        '请尽快在 GitHub 开 PR 并关联该 commit，否则团队 review 流程断档。'
      ].join('\n');
      await sendWeComMarkdown(lines);
      // 标记已推送
      await updateStore((draft) => {
        for (const bypass of overdueBypass) {
          const b = (draft.bypasses || []).find((x) => x.id === bypass.id);
          if (b) b.alertSent = true;
        }
        return draft;
      });
    } catch (err) {
      logger.error('[Scheduler/bypass]', err.message);
    }
  }

  // 每小时跑一次
  setInterval(checkBypassDeadlines, 60 * 60 * 1000);
  // 启动时延迟 30s 跑一次（等 store 加载完）
  setTimeout(checkBypassDeadlines, 30000);
}

export async function runStartupPhaseCorrection(deps) {
  const {
    loadStore,
    updateStore,
    fetchProjectDocs,
    parsePhasesFromDocs,
    defaultStageChecklist,
    reassignChecklistPhaseIds
  } = deps;

  try {
    const s = await loadStore();
    const phases = s.currentStage?.phases || [];
    const checklist = s.currentStage?.checklist || [];
    const phaseIdSet = new Set(phases.map((p) => p.id));
    const hasDocPhases = phases.length > 0 && phases.every((p) => /^phase_doc_/.test(p.id));
    const hasMissingPhaseId = checklist.some((n) => !phaseIdSet.has(n.phaseId));
    if (!hasDocPhases && !hasMissingPhaseId) return;
    logger.info('[Startup] 检测到 phases 需要修正，触发异步 LLM 重新分配...');
    const project = (s.projects || []).find((p) => p.githubFullRepo?.includes('/'));
    if (!project) return;
    const { owner, repo } = project.githubFullRepo.split('/').length >= 2
      ? { owner: project.githubFullRepo.split('/')[0], repo: project.githubFullRepo.split('/')[1] }
      : { owner: '', repo: '' };
    if (!owner || !repo) return;
    const docs = await fetchProjectDocs(owner, repo);
    if (!docs.length) return;
    const existingNodesStartup = checklist.map((n) => ({ id: n.id, title: n.title, phaseId: n.phaseId }));
    const result = await parsePhasesFromDocs(docs, [], existingNodesStartup);
    if (!result?.phases?.length) return;
    await updateStore((draft) => {
      const { phases: newPhases, nodes: newNodes, nodeAssignments } = result;
      draft.currentStage = { ...(draft.currentStage || {}), phases: newPhases };
      if ((newNodes || []).length) {
        const cur = draft.currentStage.checklist?.length ? draft.currentStage.checklist : defaultStageChecklist;
        const oldById = new Map(cur.map((n) => [n.id, n]));
        const newNodeSet = new Set(newNodes.map((n) => n.id));
        const merged = [
          ...newNodes.map((n) => {
            const old = oldById.get(n.id);
            return old ? { ...old, title: n.title || old.title, acceptance: n.acceptance || old.acceptance, phaseId: n.phaseId || old.phaseId } : n;
          }),
          ...cur.filter((n) => !newNodeSet.has(n.id) && (n.taskIds?.length > 0))
        ];
        draft.currentStage.checklist = reassignChecklistPhaseIds(merged, newPhases, nodeAssignments || {});
      }
      return draft;
    });
    logger.info('[Startup] phases 修正完成，共', result.phases.length, '个阶段');
  } catch (e) {
    logger.error('[Startup] 异步 phases 修正失败:', e.message);
  }
}
