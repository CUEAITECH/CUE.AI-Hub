export const defaultStageChecklist = [
  {
    id: 'stage_repo_signal',
    title: '真实仓库信号接入',
    owner: '胡佳涛',
    taskIds: ['task_git_webhook'],
    keywords: ['github', 'commit', 'push', 'sync', 'webhook', '仓库', '同步'],
    acceptance: '系统持续同步 CUEAITECH/Cue.AI 的 commit，并能把 Git 信号映射到成员和任务。'
  },
  {
    id: 'stage_ai_review',
    title: 'AI Review 阻断规则闭环',
    owner: '罗子宽',
    taskIds: ['task_ai_review'],
    keywords: ['review', 'ai review', '阻断', '审阅', 'token', 'auth'],
    acceptance: 'Cue.AI 提交进入 AI Review 队列，输出 Pass/Warning/Block/Escalate 和处理建议。'
  },
  {
    id: 'stage_standup_assignment',
    title: '站会与任务领取闭环',
    owner: '林世棋',
    taskIds: ['task_standup'],
    keywords: ['standup', 'assignment', '领取', '站会', '请假', '任务'],
    acceptance: '成员能提交站会、领取任务，晚会能对照昨日领取与今日 Git 证据。'
  },
  {
    id: 'stage_auto_planning',
    title: '阶段目标拆解与调整',
    owner: '田家铭',
    taskIds: ['task_auto_planning'],
    keywords: ['plan', 'planning', '阶段', '目标', '排期', '拆解'],
    acceptance: '系统能依据阶段目标生成任务，并在晚会后输出下一步调整目标。'
  },
  {
    id: 'stage_wecom_command',
    title: '企业微信项目指挥入口',
    owner: '田家铭',
    taskIds: [],
    keywords: ['wecom', '企微', '企业微信', 'summary', 'risks'],
    acceptance: '企业微信机器人可查询项目状态、风险摘要，并承接后续领取/站会写入能力。'
  }
];

function textIncludesAny(text, keywords = []) {
  const normalized = String(text || '').toLowerCase();
  return keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    const id = item.id || item.sha || JSON.stringify(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function scoreChecklistItem(item, tasks, activities, reviews, assignments) {
  const linkedTasks = tasks.filter((task) => (
    (item.taskIds || []).includes(task.id)
    || textIncludesAny(`${task.title} ${task.acceptance} ${task.signal}`, item.keywords)
  ));
  const evidenceText = [
    item.title,
    item.acceptance,
    linkedTasks.map((task) => `${task.id} ${task.title}`).join(' ')
  ].join(' ');
  const linkedActivities = uniqueById(activities.filter((activity) => (
    activity.type === 'commit'
    && (
      textIncludesAny(`${activity.title} ${(activity.files || []).join(' ')}`, item.keywords)
      || linkedTasks.some((task) => textIncludesAny(`${activity.title} ${(activity.files || []).join(' ')}`, [task.id, task.title]))
      || textIncludesAny(evidenceText, [activity.title])
    )
  )));
  const linkedReviews = uniqueById(reviews.filter((review) => (
    linkedActivities.some((activity) => review.activityId === activity.id || review.id === `review_${activity.sha}`)
    || linkedTasks.some((task) => textIncludesAny(`${review.title} ${(review.findings || []).join(' ')}`, [task.id, task.title]))
  )));
  const linkedAssignments = assignments.filter((assignment) => (
    linkedTasks.some((task) => task.id === assignment.taskId)
    || textIncludesAny(`${assignment.taskTitle} ${assignment.note}`, item.keywords)
  ));

  const taskProgress = linkedTasks.length
    ? Math.round(linkedTasks.reduce((sum, task) => sum + (Number(task.progress) || 0), 0) / linkedTasks.length)
    : 0;
  const hasBlockReview = linkedReviews.some((review) => review.level === 'Block' || review.level === 'Escalate');
  const hasEvidence = linkedActivities.length > 0 || linkedAssignments.length > 0 || linkedReviews.length > 0;
  const progress = Math.max(taskProgress, hasEvidence ? 35 : 0);
  const status = hasBlockReview
    ? '阻塞'
    : linkedTasks.some((task) => task.status === '高风险' || task.risk === '高')
    ? '高风险'
    : progress >= 100
    ? '已完成'
    : progress >= 60 || linkedActivities.length
    ? '推进中'
    : '待补证据';

  const gaps = [];
  if (!linkedTasks.length) gaps.push('缺少关联任务');
  if (!linkedActivities.length) gaps.push('缺少 Git 提交证据');
  if (!linkedAssignments.length) gaps.push('晚会未领取或未登记');
  if (hasBlockReview) gaps.push('存在阻断 Review');

  return {
    ...item,
    status,
    progress,
    linkedTasks: linkedTasks.map((task) => ({
      id: task.id,
      title: task.title,
      owner: task.owner,
      status: task.status,
      progress: task.progress,
      risk: task.risk
    })),
    evidence: {
      commits: linkedActivities.slice(0, 5).map((activity) => ({
        id: activity.id,
        title: activity.title,
        owner: activity.owner || activity.actor,
        shortSha: activity.shortSha,
        createdAt: activity.createdAt
      })),
      reviews: linkedReviews.slice(0, 5).map((review) => ({
        id: review.id,
        title: review.title,
        owner: review.owner,
        level: review.level,
        score: review.score
      })),
      assignments: linkedAssignments.slice(0, 5).map((assignment) => ({
        id: assignment.id,
        owner: assignment.owner,
        taskTitle: assignment.taskTitle,
        status: assignment.status,
        date: assignment.date
      }))
    },
    gaps
  };
}

export function buildStageChecklist(store) {
  const stage = store.currentStage || {};
  const checklistSource = Array.isArray(stage.checklist) && stage.checklist.length
    ? stage.checklist
    : defaultStageChecklist;
  const tasks = store.tasks || [];
  const activities = store.activities || [];
  const reviews = store.reviews || [];
  const assignments = store.assignments || [];
  const checklist = checklistSource.map((item) => scoreChecklistItem(item, tasks, activities, reviews, assignments));
  const progress = checklist.length
    ? Math.round(checklist.reduce((sum, item) => sum + item.progress, 0) / checklist.length)
    : 0;
  const blockedCount = checklist.filter((item) => item.status === '阻塞' || item.status === '高风险').length;
  const missingEvidenceCount = checklist.filter((item) => item.gaps.length > 0).length;

  return {
    stage: {
      id: stage.id || 'stage_mvp',
      name: stage.name || 'CUE 项目中枢 MVP',
      targetDate: stage.targetDate || '',
      status: stage.status || '进行中',
      progress
    },
    checklist,
    metrics: {
      total: checklist.length,
      done: checklist.filter((item) => item.status === '已完成').length,
      inProgress: checklist.filter((item) => item.status === '推进中').length,
      blocked: blockedCount,
      missingEvidence: missingEvidenceCount
    }
  };
}
