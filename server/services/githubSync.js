import { hasGitHubConfig, scanGitHubProject } from './githubApi.js';
import { syncProjectPRs } from './pullPipeline.js';
import { trace } from './syncTrace.js';
import { loadStore, updateStore } from '../store.js';
import { reviewChange } from './reviewer.js';
import { bindActivityToExplicitRefs } from './bindingEngine.js';
import { buildMetrics, scanRisks } from './riskEngine.js';
import { generatePlanAdjustment, persistPlanAdjustment, estimateTasksProgress } from './planner.js';
import { buildHybridAnalysis } from './semanticLinker.js';

// 自动收口的进度阈值（默认 95；可通过 AUTO_CLOSE_PROGRESS_THRESHOLD 调整）
// 设为 100 则只在 LLM 报 100% 时才自动收口；设为 90 则更宽松
const AUTO_CLOSE_PROGRESS_THRESHOLD = Math.max(50, Math.min(100, Number(process.env.AUTO_CLOSE_PROGRESS_THRESHOLD) || 95));

export async function syncGitHubProjectIntoStore(project, scanOptions = {}) {
  if (!hasGitHubConfig(project)) {
    throw new Error(`项目未配置 githubOwner，请先设置 githubOwner 和 repository`);
  }

  const scan = await scanGitHubProject(project, {
    since: scanOptions.since || '14 days ago',
    limit: Number(scanOptions.limit || 15),
    diffLimit: Number(scanOptions.diffLimit ?? 8)
  });
  const beforeStore = await loadStore();
  const existingActivityIds = new Set((beforeStore.activities || []).map((activity) => activity.id));
  const existingReviewIds = new Set((beforeStore.reviews || []).map((review) => review.id));
  const reviewCandidates = scan.activities.filter((activity) => (
    activity.type === 'commit'
    && !existingReviewIds.has(`review_${activity.sha}`)
    && String(activity.title || '').trim().length > 0
  ));
  // 先把 activity 与任务绑定，让 reviewer 拿到验收标准
  const tasksForBinding = beforeStore.tasks || [];
  const commitReviews = await Promise.all(
    reviewCandidates.map(async (activity) => {
      const bound = bindActivityToExplicitRefs(activity, beforeStore);
      const linkedTask = bound.taskId ? tasksForBinding.find((t) => t.id === bound.taskId) : null;
      return {
        id: `review_${activity.sha}`,
        projectId: project.id,
        activityId: activity.id,
        sha: activity.sha,
        shortSha: activity.shortSha,
        commitUrl: activity.url,
        actor: activity.actor,
        files: activity.files || [],
        humanDecision: null,
        ...await reviewChange({
          repo: activity.repo,
          title: activity.title,
          owner: activity.owner,
          diff: activity.diff || activity.files.join('\n'),
          files: activity.files,
          task: linkedTask || null
        })
      };
    })
  );
  const lightweightActivities = scan.activities.map(({ diff, ...activity }) => activity);
  let addedActivityCount = 0;
  let addedReviewCount = 0;

  const nextStore = await updateStore((draft) => {
    draft.projects = (draft.projects || []).map((item) =>
      item.id === project.id
        ? {
            ...item,
            branch: scan.branch,
            status: '已同步 (GitHub)',
            lastSyncAt: new Date().toISOString(),
            commitCount: scan.commitCount,
            dirtyFileCount: 0
          }
        : item
    );
    const retainedActivities = (draft.activities || []).filter((activity) => activity.projectId !== project.id);
    const mergedActivityIds = new Set();
    const projectActivities = lightweightActivities.filter((activity) => {
      if (mergedActivityIds.has(activity.id)) return false;
      mergedActivityIds.add(activity.id);
      return true;
    }).map((activity) => bindActivityToExplicitRefs(activity, draft));
    const newReviews = commitReviews.filter((review) => !existingReviewIds.has(review.id));
    addedActivityCount = projectActivities.filter((activity) => !existingActivityIds.has(activity.id)).length;
    addedReviewCount = newReviews.length;
    draft.activities = [...projectActivities, ...retainedActivities].slice(0, 700);
    draft.reviews = [...newReviews, ...(draft.reviews || [])].slice(0, 300);
    return draft;
  });

  const alerts = scanRisks(nextStore);
  const newActivities = lightweightActivities.filter((activity) => !existingActivityIds.has(activity.id));
  if (newActivities.length > 0) {
    generatePlanAdjustment(newActivities, nextStore).then((adjustment) => {
      if (!adjustment) return null;
      return persistPlanAdjustment(adjustment, newActivities, 'github-sync');
    }).catch((err) => console.error('[PlanAdjust/GitHubSync]', err.message));

    estimateTasksProgress(nextStore).then(async (results) => {
      if (!results.length) return;
      const autoClosed = [];
      await updateStore((draft) => {
        for (const r of results) {
          const task = draft.tasks.find((t) => t.id === r.taskId);
          if (!task) continue;
          const newProgress = Math.max(0, Math.min(100, Number(r.progress) || 0));
          const isManualProgress = task.progressSource === 'manual' || Boolean(task.completionSource);
          const appliedProgress = isManualProgress ? Math.max(task.progress || 0, newProgress) : newProgress;
          task.progress = appliedProgress;
          task.progressSource = isManualProgress ? 'manual' : 'auto';
          task.aiProgressSuggestion = {
            progress: newProgress,
            appliedProgress,
            reason: String(r.reason || '').slice(0, 80),
            hint: String(r.hint || '').slice(0, 100),
            suggestComplete: !!r.suggestComplete,
            updatedAt: new Date().toISOString()
          };
          // 自动收口：suggestComplete + 高进度 + 非手动 + 当前未完成
          // 如果之前自动收口过、之后又被人手动改动（updatedAt > autoClosedAt），不要再自动关
          const operatorRevertedSinceAutoClose = task.autoClosedAt
            && task.updatedAt
            && new Date(task.updatedAt).getTime() > new Date(task.autoClosedAt).getTime();
          const shouldAutoClose = !!r.suggestComplete
            && appliedProgress >= AUTO_CLOSE_PROGRESS_THRESHOLD
            && !isManualProgress
            && task.status !== 'done'
            && task.status !== 'completed'
            && !operatorRevertedSinceAutoClose;
          if (shouldAutoClose) {
            task.status = 'done';
            task.progress = 100;
            task.autoClosedAt = new Date().toISOString();
            task.autoCloseReason = String(r.reason || '').slice(0, 120);
            autoClosed.push({
              id: task.id,
              title: task.title,
              owner: task.owner,
              reason: task.autoCloseReason
            });
          }
        }
        return draft;
      });
      // 推送企微让负责人确认（不阻塞）
      if (autoClosed.length > 0) {
        try {
          const { isWeComAvailable, sendWeComMarkdown } = await import('./wecom.js');
          if (isWeComAvailable()) {
            const lines = [
              `## 🤖 AI 自动收口提醒（${autoClosed.length} 条）`,
              '',
              ...autoClosed.slice(0, 5).map((t) => `- **${t.title}**（${t.owner || '未认领'}）— ${t.reason || '已完成'}`),
              ...(autoClosed.length > 5 ? [`- ... 等共 ${autoClosed.length} 条`] : []),
              '',
              'AI 判定这些任务已完成并自动关单。如有误判请在 hub 改回 pending。'
            ].join('\n');
            await sendWeComMarkdown(lines);
          }
        } catch (err) {
          console.error('[AutoClose/WeCom] 推送失败:', err.message);
        }
      }
    }).catch((err) => console.error('[AIProgress/GitHubSync]', err.message));

    buildHybridAnalysis(nextStore).then((analysis) => {
      return updateStore((draft) => ({
        ...draft,
        semanticLinks: analysis.semanticLinks || {},
        riskAnalyses: analysis.riskAnalyses || [],
        healthAnalysis: analysis.healthAnalysis || null,
        aiAnalysisUpdatedAt: analysis.generatedAt
      }));
    }).catch((err) => console.error('[SemanticLinker/GitHubSync]', err.message));
  }
  // PR 同步（fire-and-forget，不阻塞 commit 同步流程）
  trace('github-sync-trigger', {
    projectId: project.id,
    repo: project.githubFullRepo,
    caller: new Error().stack.split('\n').slice(2, 8).map((s) => s.trim())
  });
  syncProjectPRs(project, nextStore, updateStore, { since: '14 days ago' })
    .then(({ added, updated }) => {
      if (added || updated) {
        console.log(`[GitHubSync] PR 同步 ${project.githubFullRepo}：新增 ${added} 条，更新 ${updated} 条`);
      }
    })
    .catch((err) => console.error('[GitHubSync/PRSync]', err.message));

  return {
    project: nextStore.projects.find((item) => item.id === project.id),
    source: 'github-api',
    addedActivities: addedActivityCount,
    addedReviews: addedReviewCount,
    activities: lightweightActivities,
    reviews: commitReviews,
    metrics: buildMetrics(nextStore, alerts),
    alerts
  };
}

export function githubSyncErrorHint(project, err) {
  const msg = err.message || '';
  const is404 = msg.includes('404');
  const is403 = msg.includes('403') || msg.includes('速率限制');
  const hasToken = Boolean(process.env.GITHUB_TOKEN);
  if (is404) {
    return hasToken
      ? `已配置 GITHUB_TOKEN，但无法访问仓库 "${project.githubFullRepo}"。请确认 token 的 Resource owner 是组织、已选择该仓库，并完成组织 SSO/审批授权。`
      : `仓库 "${project.githubFullRepo}" 不存在或为私有仓库。私有仓库需要在 .env 中配置 GITHUB_TOKEN。`;
  }
  if (is403) return '已触发 GitHub API 速率限制（匿名 60 次/小时）。配置 GITHUB_TOKEN 可提升至 5000 次/小时。';
  return msg;
}
