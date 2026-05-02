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

function dateText(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function addDays(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

  const today = dateText();
  const yesterday = addDays(today, -1);
  const commitsTodayByOwner = (store.activities || [])
    .filter((activity) => activity.type === 'commit' && String(activity.createdAt || '').startsWith(today))
    .reduce((owners, activity) => owners.add(activity.owner || activity.actor || '未识别'), new Set());

  for (const assignment of (store.assignments || []).filter((item) => item.date === yesterday)) {
    if (assignment.status === '已完成') continue;
    if (!commitsTodayByOwner.has(assignment.owner)) {
      alerts.push({
        id: `alert_assignment_${assignment.id}`,
        severity: 'P2',
        target: assignment.owner,
        title: `昨日领取任务「${assignment.taskTitle}」今日无提交支撑`,
        detail: '晚会前需要确认是否阻塞、拆分、转派或改为企业微信重新领取。',
        source: assignment.id
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
  const memberCount = Math.max((store.members || []).length, 1);
  const standupCount = new Set((store.standups || [])
    .filter((standup) => standup.date === today)
    .map((standup) => standup.owner)).size;
  const score = Math.max(0, 100 - highRiskTasks * 12 - blockingReviews * 8 - workingTreeFiles * 2 - alerts.filter((alert) => alert.severity === 'P1').length * 6);

  return {
    healthScore: score,
    highRiskTasks,
    commitsToday,
    workingTreeFiles,
    pendingReviews: (store.reviews || []).length,
    standupResponseRate: `${Math.round((standupCount / memberCount) * 100)}%`,
    urgentAlerts: alerts.filter((alert) => alert.severity === 'P1').length
  };
}
