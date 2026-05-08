const timezone = 'Asia/Shanghai';

function formatDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function addDays(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseWindowDate(dateText, hour) {
  return new Date(`${dateText}T${String(hour).padStart(2, '0')}:00:00+08:00`);
}

function inMeetingWindow(value, dateText, endAt = new Date()) {
  const createdAt = new Date(value);
  if (Number.isNaN(createdAt.getTime())) return false;
  const previousDate = addDays(dateText, -1);
  return createdAt >= parseWindowDate(previousDate, 18) && createdAt <= endAt;
}

function taskLabel(task) {
  return task?.title || task?.taskTitle || task?.taskId || '未关联任务';
}

function normalizeText(value, fallback = '') {
  return String(value || fallback).trim();
}

function getTask(store, taskId) {
  return (store.tasks || []).find((task) => task.id === taskId);
}

function getAssignmentTask(store, assignment) {
  return getTask(store, assignment.taskId) || {
    id: assignment.taskId || '',
    title: assignment.taskTitle || assignment.taskId || '未关联任务',
    owner: assignment.owner,
    progress: 0,
    status: assignment.status || '进行中',
    risk: '中'
  };
}

function groupActivitiesByOwner(activities) {
  return activities.reduce((groups, activity) => {
    const owner = activity.owner || activity.actor || '未识别';
    groups[owner] = groups[owner] || [];
    groups[owner].push(activity);
    return groups;
  }, {});
}

function buildReconciliation(store, dateText, endAt = new Date()) {
  const previousDate = addDays(dateText, -1);
  const assignments = (store.assignments || []).filter((item) => item.date === previousDate);
  const fallbackAssignments = assignments.length
    ? assignments
    : (store.assignments || []).filter((item) => item.date === dateText);
  const activities = (store.activities || []).filter((activity) => (
    activity.type === 'commit' && inMeetingWindow(activity.createdAt, dateText, endAt)
  ));
  const reviews = (store.reviews || []).filter((review) => inMeetingWindow(review.createdAt, dateText, endAt));
  const byOwner = groupActivitiesByOwner(activities);

  const rows = fallbackAssignments.map((assignment) => {
    const commits = byOwner[assignment.owner] || [];
    const task = getAssignmentTask(store, assignment);
    const linkedCommits = commits.filter((commit) => {
      const text = `${commit.title || ''} ${(commit.files || []).join(' ')}`.toLowerCase();
      return text.includes(String(task.id || '').toLowerCase())
        || text.includes(String(task.title || '').toLowerCase())
        || text.includes(String(assignment.taskId || '').toLowerCase());
    });
    const supportingCommits = linkedCommits.length ? linkedCommits : commits;
    const completed = assignment.status === '已完成' || task.status === '已完成' || Number(task.progress) >= 100;

    return {
      assignment,
      task,
      commits: supportingCommits,
      hasCommitSupport: supportingCommits.length > 0,
      completed,
      result: completed ? '已完成' : supportingCommits.length ? '部分完成' : '无提交支撑'
    };
  });

  return {
    previousDate,
    assignments: fallbackAssignments,
    activities,
    reviews,
    rows,
    byOwner
  };
}

function buildNextTargets(store, reconciliation, dateText) {
  const tomorrow = addDays(dateText, 1);
  const unfinishedFromAssignments = reconciliation.rows
    .filter((row) => !row.completed)
    .map((row) => ({
      owner: row.assignment.owner,
      taskId: row.task.id || row.assignment.taskId,
      taskTitle: taskLabel(row.task),
      due: tomorrow,
      priority: row.hasCommitSupport ? 'P2' : 'P1',
      reason: row.hasCommitSupport ? '已有提交但尚未完成，晚会上确认剩余验收项。' : '昨日领取任务缺少提交支撑，需要拆小或转派。'
    }));

  const urgentTasks = (store.tasks || [])
    .filter((task) => task.status !== '已完成' && (task.risk === '高' || Number(task.progress) < 60))
    .slice(0, 5)
    .map((task) => ({
      owner: task.owner,
      taskId: task.id,
      taskTitle: task.title,
      due: task.due || tomorrow,
      priority: task.risk === '高' ? 'P1' : 'P2',
      reason: task.risk === '高' ? '当前标记为高风险，晚会需要明确阻塞和负责人。' : '进度低于 60%，建议补充 Git 关联和验收标准。'
    }));

  const seen = new Set();
  return [...unfinishedFromAssignments, ...urgentTasks].filter((target) => {
    const key = `${target.owner}_${target.taskId || target.taskTitle}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function calculateStageProgress(tasks) {
  if (!tasks.length) return 0;
  const average = tasks.reduce((sum, task) => sum + (Number(task.progress) || 0), 0) / tasks.length;
  return Math.max(0, Math.min(100, Math.round(average)));
}

function formatTable(rows, columns) {
  if (!rows.length) return '> 暂无记录。';
  const head = `| ${columns.map((column) => column.label).join(' | ')} |`;
  const split = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => normalizeText(column.value(row), '-').replace(/\n/g, ' ')).join(' | ')} |`);
  return [head, split, ...body].join('\n');
}

function buildReportMarkdown(store, dateText, reconciliation, nextTargets, stageProgress, endAt = new Date()) {
  const endText = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(endAt).replace(/\//g, '-');
  const windowText = `${reconciliation.previousDate} 18:00 - ${endText}`;
  const blockReviews = reconciliation.reviews.filter((review) => review.level === 'Block');
  const warningReviews = reconciliation.reviews.filter((review) => review.level === 'Warning');
  const unassignedCommits = reconciliation.activities.filter((activity) => {
    const title = String(activity.title || '').toLowerCase();
    return !/#\d+|task_|任务|ticket/i.test(title);
  });

  const ownerRows = Object.entries(reconciliation.byOwner).map(([owner, commits]) => ({
    owner,
    count: commits.length,
    commits: commits.slice(0, 3).map((commit) => commit.shortSha || commit.title).join('、')
  }));

  return [
    `# CUE 项目中枢晚会作战包 · ${dateText}`,
    '',
    `时间窗口：${windowText}`,
    '',
    `当前阶段：${store.currentStage?.name || 'MVP'} · 进度 ${stageProgress}%`,
    '',
    '## 1. 前一天任务领取复盘',
    '',
    formatTable(reconciliation.rows, [
      { label: '成员', value: (row) => row.assignment.owner },
      { label: '领取任务', value: (row) => taskLabel(row.task) },
      { label: '完成判断', value: (row) => row.result },
      { label: 'Git 支撑', value: (row) => row.commits.length ? `${row.commits.length} 条` : '无' },
      { label: '晚会处理', value: (row) => row.completed ? '确认验收或关闭' : row.hasCommitSupport ? '确认剩余验收项' : '拆分/转派/标记阻塞' }
    ]),
    '',
    '## 2. 今日提交汇总',
    '',
    formatTable(ownerRows, [
      { label: '成员', value: (row) => row.owner },
      { label: '提交数', value: (row) => `${row.count}` },
      { label: '代表提交', value: (row) => row.commits || '-' }
    ]),
    '',
    `未关联任务提交：${unassignedCommits.length} 条。`,
    '',
    '## 3. AI Review 风险',
    '',
    `Block：${blockReviews.length} 条；Warning：${warningReviews.length} 条。`,
    '',
    formatTable(blockReviews.slice(0, 6), [
      { label: '负责人', value: (review) => review.owner },
      { label: '变更', value: (review) => review.title },
      { label: '主要问题', value: (review) => (review.findings || []).slice(0, 2).join('；') }
    ]),
    '',
    '## 4. 未完成任务与调整建议',
    '',
    formatTable(nextTargets, [
      { label: '负责人', value: (target) => target.owner },
      { label: '细化目标', value: (target) => target.taskTitle },
      { label: '优先级', value: (target) => target.priority },
      { label: '建议', value: (target) => target.reason }
    ]),
    '',
    '## 5. 晚会动作',
    '',
    '1. 逐条确认无提交支撑的领取任务：继续、拆分、转派或关闭。',
    '2. Block Review 必须明确处理人和下次检查时间。',
    '3. 晚会确认后的任务在企业微信领取，并回写到项目中枢。',
    '4. 明天 18:00 前继续按 Git 信号和 Review 结果自动对账。',
    ''
  ].join('\n');
}

export function todayText() {
  return formatDate();
}

export function normalizeAssignment(input, store) {
  const now = new Date().toISOString();
  const task = getTask(store, input.taskId);
  return {
    id: input.id || `assign_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    date: normalizeText(input.date, todayText()),
    owner: normalizeText(input.owner, task?.owner || '未分配'),
    taskId: normalizeText(input.taskId, ''),
    taskTitle: normalizeText(input.taskTitle, task?.title || input.taskId || '临时任务'),
    note: normalizeText(input.note, '晚会领取，等待 Git 信号对账'),
    status: input.status || '进行中',
    wecomStatus: input.wecomStatus || '待企业微信确认',
    createdAt: input.createdAt || now,
    updatedAt: now,
    brief: input.brief || null,
    briefGeneratedBy: input.briefGeneratedBy || null
  };
}

export function normalizeStandup(input) {
  const now = new Date().toISOString();
  return {
    id: input.id || `standup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    date: normalizeText(input.date, todayText()),
    owner: normalizeText(input.owner, '未分配'),
    yesterday: normalizeText(input.yesterday, ''),
    today: normalizeText(input.today, ''),
    blockers: normalizeText(input.blockers, '无'),
    isLeave: Boolean(input.isLeave),
    proxy: normalizeText(input.proxy, ''),
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

export function buildEveningReport(store, dateText = todayText(), endAt = new Date()) {
  const reconciliation = buildReconciliation(store, dateText, endAt);
  const nextTargets = buildNextTargets(store, reconciliation, dateText);
  const stageProgress = calculateStageProgress(store.tasks || []);
  const report = buildReportMarkdown(store, dateText, reconciliation, nextTargets, stageProgress, endAt);

  return {
    id: `evening_${dateText}`,
    date: dateText,
    generatedAt: new Date().toISOString(),
    window: {
      from: `${reconciliation.previousDate}T18:00:00+08:00`,
      to: endAt.toISOString()
    },
    summary: {
      assignmentCount: reconciliation.assignments.length,
      commitCount: reconciliation.activities.length,
      blockReviewCount: reconciliation.reviews.filter((review) => review.level === 'Block').length,
      noCommitAssignmentCount: reconciliation.rows.filter((row) => !row.hasCommitSupport && !row.completed).length,
      nextTargetCount: nextTargets.length,
      stageProgress
    },
    reconciliation: reconciliation.rows.map((row) => ({
      assignmentId: row.assignment.id,
      owner: row.assignment.owner,
      taskId: row.task.id || row.assignment.taskId,
      taskTitle: taskLabel(row.task),
      result: row.result,
      commitCount: row.commits.length,
      completed: row.completed
    })),
    nextTargets,
    report
  };
}

export function applyEveningReportProgress(store, eveningReport) {
  const nextTasks = (store.tasks || []).map((task) => {
    const row = (eveningReport.reconciliation || []).find((item) => item.taskId === task.id);
    if (!row) return task;
    if (row.completed) {
      return {
        ...task,
        status: '已完成',
        progress: 100,
        signal: '晚会对账确认完成',
        updatedAt: eveningReport.generatedAt
      };
    }
    if (row.commitCount > 0) {
      return {
        ...task,
        status: task.status === '待确认' ? '进行中' : task.status,
        progress: Math.max(Number(task.progress) || 0, Math.min(90, (Number(task.progress) || 0) + 12)),
        signal: `晚会对账：有 ${row.commitCount} 条 Git 提交支撑，待确认验收`,
        updatedAt: eveningReport.generatedAt
      };
    }
    return {
      ...task,
      risk: task.risk === '高' ? '高' : '中',
      signal: '晚会对账：昨日领取任务无提交支撑，需拆分、转派或标记阻塞',
      updatedAt: eveningReport.generatedAt
    };
  });
  const stageProgress = calculateStageProgress(nextTasks);

  return {
    ...store,
    tasks: nextTasks,
    currentStage: {
      ...(store.currentStage || {}),
      progress: stageProgress,
      status: stageProgress >= 100 ? '已完成' : '进行中',
      updatedAt: eveningReport.generatedAt
    },
    planAdjustments: [
      {
        id: `adjust_${eveningReport.date}`,
        date: eveningReport.date,
        title: `${eveningReport.date} 晚会后开发目标调整`,
        targets: eveningReport.nextTargets,
        createdAt: eveningReport.generatedAt
      },
      ...(store.planAdjustments || []).filter((item) => item.id !== `adjust_${eveningReport.date}`)
    ].slice(0, 30)
  };
}
