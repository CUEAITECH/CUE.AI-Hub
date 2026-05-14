const DEFAULT_PROJECT_ID = 'cue_ai_classroom';

const STATUS = {
  NORMAL: 'normal',
  DELAYED: 'delayed',
  APPROVED_LEAVE: 'approved_leave',
  TEMP_LEAVE: 'temporary_leave',
  ABSENT: 'absent'
};

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function shanghaiDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

function addDays(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isCompanyWorkday(dateText = shanghaiDate()) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay();
  return dayOfWeek !== 3 && dayOfWeek !== 6;
}

export function nextCompanyWorkday(dateText = shanghaiDate()) {
  let date = dateText;
  while (!isCompanyWorkday(date)) date = addDays(date, 1);
  return date;
}

function scoringDateForActivity(value) {
  const date = shanghaiDate(value);
  return isCompanyWorkday(date) ? date : nextCompanyWorkday(date);
}

function weekStartMonday(dateText = shanghaiDate()) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - dayOfWeek + 1);
  return date.toISOString().slice(0, 10);
}

function weekDates(dateText = shanghaiDate()) {
  const start = weekStartMonday(dateText);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function inProject(item = {}, projectId = DEFAULT_PROJECT_ID) {
  return !item.projectId || item.projectId === projectId;
}

function sameDate(value, dateText) {
  return shanghaiDate(value) === dateText;
}

function isDoneStatus(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('完成') || text.includes('done') || text.includes('complete') || text === '100';
}

function isHighRisk(value) {
  return String(value || '').includes('高') || String(value || '').toLowerCase() === 'high';
}

function priorityWeight(value) {
  const text = String(value || '').toUpperCase();
  if (text.includes('P0')) return 1.5;
  if (text.includes('P1') || text.includes('高')) return 1.3;
  if (text.includes('P2') || text.includes('中')) return 1.1;
  return 1;
}

function memberNames(store, projectId) {
  const names = new Set();
  for (const member of store.members || []) {
    if (member?.name) names.add(member.name);
  }
  for (const user of store.users || []) {
    const ids = Array.isArray(user.projectIds) ? user.projectIds : [];
    if ((ids.includes('*') || ids.includes(projectId)) && user.role !== 'admin' && user.active !== false) {
      names.add(user.name || user.username);
    }
  }
  for (const item of [...(store.assignments || []), ...(store.activities || []), ...(store.reviews || []), ...(store.standups || [])]) {
    const owner = item.owner || item.actor;
    if (owner && owner !== '未识别' && owner !== '未分配' && owner !== '待认领') names.add(owner);
  }
  return [...names].filter(Boolean);
}

function taskById(store) {
  return new Map((store.tasks || []).map((task) => [task.id, task]));
}

function attendanceFor(store, projectId, date, owner, kind) {
  return (store.attendanceRecords || [])
    .filter((item) => inProject(item, projectId) && item.date === date && item.owner === owner && item.kind === kind)
    .sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')))[0] || null;
}

function standupFor(store, projectId, date, owner) {
  return (store.standups || []).find((item) => inProject(item, projectId) && item.date === date && item.owner === owner) || null;
}

function scoreTasks(store, projectId, date, owner) {
  const tasks = taskById(store);
  const assignments = (store.assignments || []).filter((item) => (
    inProject(item, projectId) && item.date === date && item.owner === owner
  ));
  if (!assignments.length) {
    return { score: 28, completed: 0, total: 0, detail: '当天无领取任务，按中性分处理' };
  }
  let totalWeight = 0;
  let doneWeight = 0;
  let overdueWeight = 0;
  for (const assignment of assignments) {
    const task = tasks.get(assignment.taskId) || {};
    const weight = priorityWeight(task.priority || assignment.priority || task.risk);
    totalWeight += weight;
    const done = isDoneStatus(assignment.status) || isDoneStatus(task.status) || Number(task.progress) >= 100;
    if (done) doneWeight += weight;
    const due = task.due || task.dueDate || '';
    if (!done && due && due < date) overdueWeight += weight;
  }
  const completion = totalWeight ? doneWeight / totalWeight : 0;
  const overduePenalty = totalWeight ? Math.min(12, (overdueWeight / totalWeight) * 18) : 0;
  return {
    score: clamp(40 * completion - overduePenalty, 0, 40),
    completed: assignments.filter((assignment) => {
      const task = tasks.get(assignment.taskId) || {};
      return isDoneStatus(assignment.status) || isDoneStatus(task.status) || Number(task.progress) >= 100;
    }).length,
    total: assignments.length,
    detail: overduePenalty ? '存在逾期领取任务，已扣除延期分' : '按领取任务完成率和优先级计分'
  };
}

function scoreCommits(store, projectId, date, owner) {
  const commits = (store.activities || []).filter((item) => (
    inProject(item, projectId) && item.type === 'commit' && scoringDateForActivity(item.createdAt || item.date) === date && (item.owner || item.actor) === owner
  ));
  const linked = commits.filter((item) => item.taskId || item.deliverableId);
  const unlinked = commits.length - linked.length;
  const score = clamp(linked.length * 8 + unlinked * 3 - Math.max(0, unlinked - linked.length) * 2, 0, 25);
  return {
    score,
    commits: commits.length,
    linked: linked.length,
    detail: commits.length ? `${linked.length}/${commits.length} 条 commit 已绑定任务或交付物` : '当天无 Git 提交'
  };
}

function scoreReviews(store, projectId, date, owner) {
  const reviews = (store.reviews || []).filter((item) => (
    inProject(item, projectId) && sameDate(item.createdAt || item.date, date) && (item.owner || item.actor) === owner
  ));
  if (!reviews.length) return { score: 14, count: 0, average: null, detail: '当天无 AI Review，按中性分处理' };
  const avg = reviews.reduce((sum, item) => sum + clamp(item.score, 0, 100), 0) / reviews.length;
  const blockPenalty = reviews.filter((item) => item.level === 'Block').length * 5;
  const escalatePenalty = reviews.filter((item) => item.level === 'Escalate').length * 7;
  return {
    score: clamp((avg / 100) * 20 - blockPenalty - escalatePenalty, 0, 20),
    count: reviews.length,
    average: Math.round(avg),
    detail: `Review 均分 ${Math.round(avg)}，Block/Escalate 会额外扣分`
  };
}

function scoreClosure(store, projectId, date, owner) {
  const assignments = (store.assignments || []).filter((item) => (
    inProject(item, projectId) && item.date === date && item.owner === owner
  ));
  const commits = (store.activities || []).filter((item) => (
    inProject(item, projectId) && item.type === 'commit' && scoringDateForActivity(item.createdAt || item.date) === date && (item.owner || item.actor) === owner
  ));
  const standup = standupFor(store, projectId, date, owner);
  let score = 5;
  if (standup) score += 4;
  if (assignments.length && commits.length) score += 4;
  if (assignments.some((item) => isDoneStatus(item.status))) score += 2;
  return {
    score: clamp(score, 0, 15),
    hasStandup: Boolean(standup),
    detail: standup ? '有站会/闭环记录' : '缺少站会或闭环记录'
  };
}

function attendanceStatusScore(status) {
  if (status === STATUS.NORMAL || status === STATUS.DELAYED || status === STATUS.APPROVED_LEAVE) return 10;
  if (status === STATUS.TEMP_LEAVE) return 7;
  if (status === STATUS.ABSENT) return 0;
  return 6;
}

function taskCompletionStatusScore(status) {
  if (status === STATUS.NORMAL || status === STATUS.APPROVED_LEAVE) return 10;
  if (status === STATUS.DELAYED) return 8;
  if (status === STATUS.TEMP_LEAVE) return 7;
  if (status === STATUS.ABSENT) return 0;
  return 6;
}

function attendanceLabel(status) {
  return {
    [STATUS.NORMAL]: '正常',
    [STATUS.DELAYED]: '延迟',
    [STATUS.APPROVED_LEAVE]: '提前请假',
    [STATUS.TEMP_LEAVE]: '临时请假',
    [STATUS.ABSENT]: '缺勤'
  }[status] || '未确认';
}

function scoreAttendance(store, projectId, date, owner) {
  const meeting = attendanceFor(store, projectId, date, owner, 'meeting');
  const task = attendanceFor(store, projectId, date, owner, 'task_completion');
  const meetingScore = attendanceStatusScore(meeting?.status);
  const taskScore = taskCompletionStatusScore(task?.status);
  const points = Math.round((meetingScore * 0.5 + taskScore * 0.5));
  return {
    points,
    meetingStatus: meeting?.status || 'unknown',
    taskStatus: task?.status || 'unknown',
    detail: `晚会${attendanceLabel(meeting?.status)}，任务${attendanceLabel(task?.status)}`
  };
}

function carryoverDates(store, projectId, date, owner) {
  const record = attendanceFor(store, projectId, date, owner, 'task_completion');
  if (!record || record.status !== STATUS.DELAYED) return [date];
  const dates = [date, addDays(date, 1)];
  const next = attendanceFor(store, projectId, addDays(date, 1), owner, 'task_completion');
  if (next?.status === STATUS.APPROVED_LEAVE || next?.status === STATUS.TEMP_LEAVE) {
    dates.push(addDays(date, 2));
  }
  return [...new Set(dates)];
}

export function buildDailyScores(store, { projectId = DEFAULT_PROJECT_ID, date = shanghaiDate(), totalBonus = 0, attendanceBonusBase = 0 } = {}) {
  const workday = isCompanyWorkday(date);
  if (!workday) {
    return { date, projectId, isWorkday: false, rows: [], note: '公司固定休息日（周三/周六），不产生任务和晚会评分；休息日 commit 顺延计入下一个工作日。' };
  }
  const rows = memberNames(store, projectId).map((owner) => {
    const tasks = scoreTasks(store, projectId, date, owner);
    const commits = scoreCommits(store, projectId, date, owner);
    const reviews = scoreReviews(store, projectId, date, owner);
    const closure = scoreClosure(store, projectId, date, owner);
    const attendance = scoreAttendance(store, projectId, date, owner);
    const contributionRaw = clamp(tasks.score + commits.score + reviews.score + closure.score, 0, 100);
    const contributionScore = Math.round(contributionRaw * 0.9);
    const dailyScore = clamp(contributionScore + attendance.points, 0, 100);
    const carryover = carryoverDates(store, projectId, date, owner);
    return {
      owner,
      date,
      projectId,
      dailyScore: Math.round(dailyScore),
      contributionScore,
      attendancePoints: attendance.points,
      contributionRaw: Math.round(contributionRaw),
      components: {
        taskDelivery: tasks,
        effectiveCommits: commits,
        reviewQuality: reviews,
        closure,
        attendance
      },
      carryoverDates: carryover,
      baseBonusEstimate: totalBonus ? Math.round((dailyScore / 100) * Number(totalBonus)) : 0,
      attendanceBonusEligible: attendance.meetingStatus === STATUS.NORMAL && attendance.taskStatus === STATUS.NORMAL,
      attendanceBonusEstimate: attendanceBonusBase && attendance.meetingStatus === STATUS.NORMAL && attendance.taskStatus === STATUS.NORMAL
        ? Number(attendanceBonusBase)
        : 0
    };
  });
  rows.sort((a, b) => b.dailyScore - a.dailyScore || b.contributionScore - a.contributionScore || a.owner.localeCompare(b.owner, 'zh-CN'));
  return { date, projectId, isWorkday: true, rows };
}

export function buildWeeklyScores(store, { projectId = DEFAULT_PROJECT_ID, date = shanghaiDate(), totalBonus = 0, attendanceBonusBase = 0 } = {}) {
  const today = shanghaiDate();
  const dates = weekDates(date)
    .filter((item) => item <= today && isCompanyWorkday(item));
  const byOwner = new Map();
  for (const day of dates) {
    for (const row of buildDailyScores(store, { projectId, date: day, totalBonus, attendanceBonusBase }).rows) {
      if (!byOwner.has(row.owner)) byOwner.set(row.owner, []);
      byOwner.get(row.owner).push(row);
    }
  }
  const rows = [...byOwner.entries()].map(([owner, dailyRows]) => {
    const weeklyScore = dailyRows.length
      ? Math.round(dailyRows.reduce((sum, row) => sum + row.dailyScore, 0) / dailyRows.length)
      : 0;
    const contributionScore = dailyRows.length
      ? Math.round(dailyRows.reduce((sum, row) => sum + row.contributionScore, 0) / dailyRows.length)
      : 0;
    const attendancePoints = dailyRows.length
      ? Math.round(dailyRows.reduce((sum, row) => sum + row.attendancePoints, 0) / dailyRows.length)
      : 0;
    return {
      owner,
      projectId,
      weekStart: dates[0] || weekStartMonday(date),
      weekEnd: dates[dates.length - 1] || addDays(weekStartMonday(date), 6),
      weeklyScore,
      contributionScore,
      attendancePoints,
      workdays: dailyRows.length,
      dailyRows
    };
  });
  rows.sort((a, b) => b.weeklyScore - a.weeklyScore || b.contributionScore - a.contributionScore || a.owner.localeCompare(b.owner, 'zh-CN'));
  return {
    date,
    projectId,
    weekStart: dates[0] || weekStartMonday(date),
    weekEnd: dates[dates.length - 1] || addDays(weekStartMonday(date), 6),
    workdays: dates,
    rows
  };
}

export function buildMonthlyScores(store, { projectId = DEFAULT_PROJECT_ID, month = shanghaiDate().slice(0, 7), totalBonus = 0, attendanceBonusBase = 0 } = {}) {
  const today = shanghaiDate();
  const days = [];
  for (let d = `${month}-01`; d <= today && d.startsWith(month); d = addDays(d, 1)) {
    if (isCompanyWorkday(d)) days.push(d);
  }
  const byOwner = new Map();
  for (const date of days) {
    for (const row of buildDailyScores(store, { projectId, date }).rows) {
      if (!byOwner.has(row.owner)) byOwner.set(row.owner, []);
      byOwner.get(row.owner).push(row);
    }
  }
  const rows = [...byOwner.entries()].map(([owner, dailyRows]) => {
    const monthlyScore = dailyRows.length
      ? Math.round(dailyRows.reduce((sum, row) => sum + row.dailyScore, 0) / dailyRows.length)
      : 0;
    const attendanceOk = dailyRows.filter((row) => row.attendanceBonusEligible).length;
    const attendanceRate = dailyRows.length ? attendanceOk / dailyRows.length : 0;
    return {
      owner,
      month,
      monthlyScore,
      attendanceRate,
      baseBonus: totalBonus ? Math.round((monthlyScore / 100) * Number(totalBonus)) : 0,
      attendanceBonus: attendanceBonusBase && attendanceRate >= 0.9 && monthlyScore >= 75 ? Number(attendanceBonusBase) : 0,
      dailyRows
    };
  });
  rows.sort((a, b) => b.monthlyScore - a.monthlyScore || a.owner.localeCompare(b.owner, 'zh-CN'));
  return { month, projectId, rows };
}

function statusFromMessage(text, kind, now = new Date()) {
  if (/提前请假/.test(text)) return STATUS.APPROVED_LEAVE;
  if (/临时请假/.test(text)) return STATUS.TEMP_LEAVE;
  if (/缺勤/.test(text)) return STATUS.ABSENT;
  if (kind === 'task_completion') {
    if (/正常完成/.test(text)) return STATUS.NORMAL;
    if (/延迟完成/.test(text)) return STATUS.DELAYED;
  }
  if (kind === 'meeting') {
    if (/正常出席|延迟出席/.test(text)) {
      const hm = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(now);
      if (hm <= '18:25') return STATUS.NORMAL;
      if (hm <= '18:35') return STATUS.TEMP_LEAVE;
      return STATUS.ABSENT;
    }
  }
  return '';
}

export function parseAttendanceMessage(text = '', now = new Date()) {
  const raw = String(text || '').trim();
  const owner = raw.replace(/@[^\s]+/g, '').match(/^(.+?)(正常完成|延迟完成|正常出席|延迟出席|提前请假|临时请假|缺勤)/)?.[1]?.trim() || '';
  const kind = /正常完成|延迟完成/.test(raw) ? 'task_completion' : 'meeting';
  const status = statusFromMessage(raw, kind, now);
  if (!owner || !status) return null;
  return { owner, kind, status, rawMessage: raw };
}

export function normalizeAttendanceRecord(input = {}) {
  const now = new Date().toISOString();
  return {
    id: input.id || `attendance_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: input.projectId || DEFAULT_PROJECT_ID,
    date: input.date || shanghaiDate(),
    owner: String(input.owner || '').trim(),
    kind: input.kind === 'task_completion' ? 'task_completion' : 'meeting',
    status: Object.values(STATUS).includes(input.status) ? input.status : STATUS.ABSENT,
    source: input.source || 'manual',
    editedBy: input.editedBy || '',
    rawMessage: input.rawMessage || '',
    note: input.note || '',
    recordedAt: input.recordedAt || now,
    updatedAt: now
  };
}

export function canManageAttendance(user = {}, projectId = '') {
  const role = user.projectRole || user.role || '';
  return ['admin', 'hr_manager'].includes(role)
    || user.role === 'admin'
    || user.projectRoles?.[projectId] === 'hr_manager'
    || user.projectRoles?.['*'] === 'hr_manager';
}
