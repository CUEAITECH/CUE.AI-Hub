function parseDueDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysUntil(date) {
  const now = new Date();
  return Math.ceil((date.getTime() - now.getTime()) / 86400000);
}

function hoursSince(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((Date.now() - date.getTime()) / 3600000);
}

export function scanRisks(store) {
  const alerts = [];

  for (const task of store.tasks || []) {
    const due = parseDueDate(task.due);
    const remainingDays = due ? daysUntil(due) : null;
    const idleHours = hoursSince(task.updatedAt);

    if (remainingDays !== null && remainingDays <= 0 && task.progress < 100) {
      alerts.push({
        id: `alert_due_${task.id}`,
        severity: 'P1',
        target: task.owner,
        title: `任务「${task.title}」已到期但未完成`,
        detail: `当前进度 ${task.progress}%，需要更新进展、拆分任务或标记阻塞。`,
        source: task.id
      });
    } else if (remainingDays !== null && remainingDays <= 1 && task.progress < 60) {
      alerts.push({
        id: `alert_due_soon_${task.id}`,
        severity: 'P2',
        target: task.owner,
        title: `任务「${task.title}」临近截止`,
        detail: `剩余 ${Math.max(remainingDays, 0)} 天，当前进度 ${task.progress}%。`,
        source: task.id
      });
    }

    if (idleHours !== null && idleHours >= 24 && task.progress < 100) {
      alerts.push({
        id: `alert_idle_${task.id}`,
        severity: 'P2',
        target: task.owner,
        title: `任务「${task.title}」超过 24 小时无更新`,
        detail: task.signal || '无最新进展信号。',
        source: task.id
      });
    }

    if (!task.linkedRefs?.length && task.status !== '待确认') {
      alerts.push({
        id: `alert_no_git_${task.id}`,
        severity: 'P3',
        target: task.owner,
        title: `任务「${task.title}」没有关联 Git 信号`,
        detail: '请关联 commit、branch 或 PR，避免进度不可验证。',
        source: task.id
      });
    }
  }

  for (const review of store.reviews || []) {
    if (review.level === 'Block') {
      alerts.push({
        id: `alert_review_${review.id}`,
        severity: 'P1',
        target: review.owner,
        title: `AI Review 阻断：${review.title}`,
        detail: review.findings?.join('；') || '存在阻断项。',
        source: review.id
      });
    }
  }

  return alerts;
}

export function buildMetrics(store, alerts = []) {
  const today = new Date().toISOString().slice(0, 10);
  const commitsToday = (store.activities || []).filter((activity) => {
    return activity.type === 'commit' && String(activity.createdAt || '').startsWith(today);
  }).length;
  const workingTreeFiles = (store.activities || []).filter((activity) => activity.type === 'working_tree').length;
  const blockingReviews = (store.reviews || []).filter((review) => review.level === 'Block').length;
  const highRiskTasks = (store.tasks || []).filter((task) => task.risk === '高').length;
  const score = Math.max(0, 100 - highRiskTasks * 12 - blockingReviews * 8 - workingTreeFiles * 2 - alerts.filter((alert) => alert.severity === 'P1').length * 6);

  return {
    healthScore: score,
    highRiskTasks,
    commitsToday,
    workingTreeFiles,
    pendingReviews: (store.reviews || []).length,
    standupResponseRate: '75%',
    urgentAlerts: alerts.filter((alert) => alert.severity === 'P1').length
  };
}
