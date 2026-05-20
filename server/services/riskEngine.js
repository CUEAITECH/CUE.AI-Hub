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

    if (idleHours !== null && idleHours >= 24 && task.status === '进行中' && task.progress > 0 && task.progress < 100) {
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
    if (review.level === 'Block' && !review.humanDecision) {
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

  // PR 超 48h 未合并告警
  const now48hAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  for (const pull of store.pulls || []) {
    if (pull.state !== 'open') continue;
    if ((pull.createdAt || '') < now48hAgo) {
      alerts.push({
        id: `alert_pr_stuck_${pull.id}`,
        severity: 'P2',
        target: pull.author || '未知',
        title: `PR #${pull.number} 超 48h 未合并`,
        detail: `「${pull.title || ''}」开了超过 48 小时仍未 merge 或关闭。`,
        source: pull.id
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

  const analysisById = Object.fromEntries((store.riskAnalyses || []).map((analysis) => [analysis.alertId, analysis]));
  return alerts.map((alert) => {
    const analysis = analysisById[alert.id];
    if (!analysis) return alert;
    const severity = alert.severity === 'P1' ? alert.severity : (analysis.severity || alert.severity);
    return {
      ...alert,
      severity,
      aiAnalysis: {
        confidence: analysis.confidence,
        reason: analysis.reason,
        action: analysis.action
      }
    };
  });
}

// DORA-aligned weighted geometric mean（对齐 SPACE/DORA 框架）
// 几何平均比线性加权更能放大低分维度的影响：任意一维趋近 0 时总分同步趋近 0，
// 而线性加权允许其他维度"补偿"该短板，掩盖真实瓶颈。
// 参考：Forsgren et al. "The SPACE of Developer Productivity" (ACM Queue, 2021)
//      DORA "State of DevOps Report" — https://dora.dev
function weightedGeometricMean(dimensions) {
  // dimensions: Array<{ score: number, weight: number }>，weight 之和须为 1
  // 使用 max(score, 1) 防止 ln(0)；score=1 时对总分贡献接近 0，不会无限惩罚新团队
  return Math.min(100, Math.round(
    dimensions.reduce((product, { score, weight }) =>
      product * Math.pow(Math.max(score, 1), weight), 1)
  ));
}

export function buildMetrics(store, alerts = []) {
  const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
  const todayShanghai = fmt(new Date());
  const sevenDaysAgo = fmt(new Date(Date.now() - 7 * 24 * 3600 * 1000));
  const thirtyDaysAgo = fmt(new Date(Date.now() - 30 * 24 * 3600 * 1000));

  const memberCount = Math.max((store.members || []).length, 1);

  // DORA 维度一：Deployment Frequency → 7 日 commit 活跃度（人均每天 1 条 = 满分）
  const commits7d = (store.activities || []).filter((a) => {
    const d = a.createdAt || a.date || '';
    return a.type === 'commit' && fmt(new Date(d)) >= sevenDaysAgo;
  }).length;
  const commitsToday = (store.activities || []).filter((a) => {
    const d = a.createdAt || a.date || '';
    return a.type === 'commit' && fmt(new Date(d)) === todayShanghai;
  }).length;
  const activityScore = Math.min(100, Math.round(commits7d / (memberCount * 7) * 100));

  // 维度二：任务健康（高风险任务占比）
  const totalTasks = Math.max((store.tasks || []).length, 1);
  const highRiskTasks = (store.tasks || []).filter((t) => t.risk === '高').length;
  const taskScore = Math.round((1 - highRiskTasks / totalTasks) * 100);

  // DORA 维度三：Change Failure Rate → PR 合规率（PR 流）+ commit Block 兜底
  const reviews30d = (store.reviews || []).filter((r) => (r.createdAt || '') >= thirtyDaysAgo);
  const mergedPulls30d = (store.pulls || []).filter((p) => p.mergedAt && p.mergedAt >= thirtyDaysAgo);
  let reviewScore;
  let unresolvedBlocks30d = 0;
  if (mergedPulls30d.length > 0) {
    // PR 有 hubReview：计算 Block/Escalate 比率
    const blockPulls = mergedPulls30d.filter((p) =>
      p.hubReview?.level === 'Block' || p.hubReview?.level === 'Escalate'
    ).length;
    reviewScore = Math.round((1 - blockPulls / mergedPulls30d.length) * 100);
  } else {
    // 无 PR 数据时回退到 commit review Block 比率
    unresolvedBlocks30d = reviews30d.filter((r) => r.level === 'Block' && !r.humanDecision).length;
    reviewScore = reviews30d.length
      ? Math.round((1 - unresolvedBlocks30d / reviews30d.length) * 100)
      : 100;
  }

  // DORA 维度四：MTTR → 近 30 天已解决 Block 的平均响应时长（0h=100, ≥48h=0）
  const resolvedBlocks30d = reviews30d.filter((r) => r.level === 'Block' && r.humanDecision && r.updatedAt);
  let mttrScore = 100;
  let avgMttrHours = null;
  if (resolvedBlocks30d.length > 0) {
    avgMttrHours = resolvedBlocks30d.reduce((sum, r) => {
      const delta = new Date(r.updatedAt).getTime() - new Date(r.createdAt || r.updatedAt).getTime();
      return sum + Math.max(0, delta / 3600000);
    }, 0) / resolvedBlocks30d.length;
    mttrScore = Math.max(0, Math.round(100 - (avgMttrHours / 48) * 100));
  }

  // 维度五：7 日站会覆盖率（近 7 天有过站会记录的成员比率）
  const standupOwners7d = new Set(
    (store.standups || [])
      .filter((s) => (s.date || '') >= sevenDaysAgo)
      .map((s) => s.owner)
  );
  const standupScore = Math.round(Math.min(standupOwners7d.size, memberCount) / memberCount * 100);

  // 几何平均聚合：权重对齐 DORA 四指标优先级，站会作为团队协作辅助维度
  const baseScore = weightedGeometricMean([
    { score: activityScore, weight: 0.25 },
    { score: taskScore,     weight: 0.25 },
    { score: reviewScore,   weight: 0.25 },
    { score: mttrScore,     weight: 0.15 },
    { score: standupScore,  weight: 0.10 }
  ]);

  const adjustment = Math.max(-5, Math.min(5, Number(store.healthAnalysis?.adjustment) || 0));
  const score = Math.max(0, Math.min(100, baseScore + adjustment));

  const actionableReviews = (store.reviews || []).filter(
    (r) => (r.level === 'Block' || r.level === 'Escalate') && !r.humanDecision
  ).length;

  return {
    healthScore: score,
    baseHealthScore: baseScore,
    healthAdjustment: adjustment,
    healthAnalysis: store.healthAnalysis || null,
    healthComponents: {
      activity:    { score: activityScore, weight: 0.25, doraMetric: 'Deployment Frequency', detail: `近7日 ${commits7d} 条commit` },
      taskRisk:    { score: taskScore,     weight: 0.25, detail: `${highRiskTasks}/${totalTasks} 个高风险任务` },
      reviewClean: { score: reviewScore,   weight: 0.25, doraMetric: 'Change Failure Rate',  detail: `近30日 ${unresolvedBlocks30d}/${reviews30d.length} 条Block未处理` },
      mttr:        { score: mttrScore,     weight: 0.15, doraMetric: 'MTTR', detail: resolvedBlocks30d.length ? `近30日Block平均解决 ${avgMttrHours != null ? avgMttrHours.toFixed(1) : '?'}h` : '近30日无已解决Block' },
      standup:     { score: standupScore,  weight: 0.10, detail: `近7日 ${standupOwners7d.size}/${memberCount} 人有站会记录` }
    },
    highRiskTasks,
    commitsToday,
    pendingReviews: actionableReviews,
    standupResponseRate: `${standupScore}%`,
    urgentAlerts: alerts.filter((a) => a.severity === 'P1').length
  };
}
