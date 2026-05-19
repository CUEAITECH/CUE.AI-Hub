import { bindAssignmentToExplicitRefs } from '../services/bindingEngine.js';
import {
  buildDailyScores,
  buildWeeklyScores,
  normalizeAttendanceRecord,
  parseAttendanceMessage
} from '../services/scoring.js';

function formatShanghaiTime(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatList(items, formatter, emptyText, limit = 3) {
  const picked = (items || []).slice(0, limit);
  if (!picked.length) return emptyText;
  return picked.map((item, index) => `${index + 1}. ${formatter(item)}`).join('\n');
}

function resolveRankingType(input = '') {
  const text = String(input || '').toLowerCase();
  if (/weekly|week|每周|本周|周榜|周排名/.test(text)) return 'weekly';
  if (/daily|today|每日|今日|日榜|日排名|排名/.test(text)) return 'daily';
  return '';
}

function buildWeComScoreRanking(store, { projectId, type = 'daily', date, todayText }) {
  const rankingDate = date || todayText();
  const payload = type === 'weekly'
    ? buildWeeklyScores(store, { projectId, date: rankingDate })
    : buildDailyScores(store, { projectId, date: rankingDate });
  const rows = (payload.rows || []).slice(0, 10);
  const project = (store.projects || []).find((item) => item.id === projectId) || {};
  const title = type === 'weekly'
    ? `${payload.weekStart || rankingDate} - ${payload.weekEnd || rankingDate} 每周评分排行`
    : `${payload.date || rankingDate} 每日评分排行`;
  const lines = [
    `# ${project.name || 'CUE 项目'} ${title}`,
    ''
  ];
  if (!rows.length) {
    lines.push(payload.note || '暂无评分数据，等待 GitHub 同步和考勤记录。');
  } else {
    lines.push(...rows.map((row, index) => {
      const score = type === 'weekly' ? row.weeklyScore : row.dailyScore;
      const detail = type === 'weekly'
        ? `贡献 ${Math.round(row.contributionScore || 0)} · 出勤 ${Math.round(row.attendancePoints || 0)} · ${row.workdays || 0} 个工作日`
        : `贡献 ${Math.round(row.contributionScore || 0)} · 出勤 +${Math.round(row.attendancePoints || 0)}`;
      return `${index + 1}. ${row.owner} ${Math.round(score || 0)} 分\n   ${detail}`;
    }));
  }
  return {
    projectId,
    type,
    date: rankingDate,
    ranking: payload,
    summary: lines.join('\n'),
    generatedAt: new Date().toISOString()
  };
}

function buildWeComProjectSummary(store, alerts, buildMetrics) {
  const metrics = buildMetrics(store, alerts);
  const project = (store.projects || [])[0] || {};
  const activeTasks = (store.tasks || [])
    .filter((task) => task.status !== '已完成')
    .sort((a, b) => (b.risk === '高') - (a.risk === '高') || (a.progress || 0) - (b.progress || 0));
  const p1Alerts = alerts.filter((alert) => alert.severity === 'P1');
  const recentActivities = (store.activities || []).filter((activity) => activity.type === 'commit');
  const blockingReviews = (store.reviews || []).filter((review) => review.level === 'Block');

  const projectLine = project.githubFullRepo || project.repository
    ? `${project.name || project.repository}（${project.githubFullRepo || project.repository}）`
    : '尚未配置真实仓库';

  return [
    `项目状态：${projectLine}`,
    `同步状态：${project.status || '待同步'}；分支：${project.branch || '未记录'}；最近同步：${formatShanghaiTime(project.lastSyncAt)}`,
    `健康度：${metrics.healthScore} 分；高风险任务：${metrics.highRiskTasks} 个；P1 告警：${metrics.urgentAlerts} 个；待审阅：${metrics.pendingReviews} 条；今日提交：${metrics.commitsToday} 次；站会响应率：${metrics.standupResponseRate}`,
    '',
    '当前重点任务：',
    formatList(
      activeTasks,
      (task) => `${task.owner || '未分配'}「${task.title}」${task.progress ?? 0}% / ${task.status || '待确认'} / 风险${task.risk || '未标注'} / 截止 ${task.due || '未定'}`,
      '暂无未完成任务。',
      5
    ),
    '',
    '优先处理风险：',
    formatList(
      p1Alerts.length ? p1Alerts : alerts.filter((alert) => alert.severity === 'P2'),
      (alert) => `${alert.severity} ${alert.target || '未指定'}：${alert.title}。${alert.detail || ''}`,
      '当前无 P1/P2 风险。',
      5
    ),
    '',
    '最近提交：',
    formatList(
      recentActivities,
      (activity) => `${activity.owner || activity.actor || '未知'}：${activity.title || '未命名提交'}（${formatShanghaiTime(activity.createdAt)}）`,
      '暂无 GitHub 提交记录。',
      5
    ),
    '',
    blockingReviews.length
      ? `AI Review 阻断：${blockingReviews.slice(0, 3).map((review) => `${review.owner || '未知'}「${review.title}」`).join('；')}`
      : 'AI Review 阻断：暂无。'
  ].join('\n');
}

function buildWeComRiskSummary(store, alerts, buildMetrics) {
  const metrics = buildMetrics(store, alerts);
  const counts = ['P1', 'P2', 'P3'].map((level) => `${level} ${alerts.filter((alert) => alert.severity === level).length}`).join(' / ');
  const highRiskTasks = (store.tasks || []).filter((task) => task.risk === '高' || task.status === '高风险');
  const staleTasks = alerts.filter((alert) => alert.id?.includes('idle'));
  const noGitTasks = alerts.filter((alert) => alert.id?.includes('no_git'));

  return [
    `风险摘要：${counts}；项目健康度 ${metrics.healthScore} 分。`,
    '',
    '最高优先级告警：',
    formatList(
      alerts.filter((alert) => alert.severity === 'P1'),
      (alert) => `${alert.target || '未指定'}：${alert.title}。${alert.detail || ''}`,
      '当前无 P1 告警。',
      5
    ),
    '',
    '高风险任务：',
    formatList(
      highRiskTasks,
      (task) => `${task.owner || '未分配'}「${task.title}」${task.progress ?? 0}% / ${task.status || '待确认'} / 截止 ${task.due || '未定'}`,
      '当前无高风险任务。',
      5
    ),
    '',
    '需要晚会确认：',
    formatList(
      [...staleTasks, ...noGitTasks],
      (alert) => `${alert.target || '未指定'}：${alert.title}`,
      '暂无需要晚会确认的停滞或无 Git 信号任务。',
      5
    ),
    '',
    '建议动作：晚会先处理 P1 阻断，再让无 Git 信号任务补关联 commit/PR，最后把超过 24 小时无更新的任务拆分、转派或重新领取。'
  ].join('\n');
}

function resolveProjectContext(store, url, json = {}) {
  const requested = String(json?.projectId || url.searchParams.get('projectId') || '').trim();
  const projects = store.projects || [];
  if (!requested) return { projectId: projects[0]?.id || '', project: projects[0] || null };
  const project = projects.find((item) => item.id === requested);
  return { projectId: project?.id || projects[0]?.id || requested, project: project || projects[0] || null };
}

function scopeStoreToProject(store, projectId) {
  if (!projectId) return store;
  const byProject = (items = []) => items.filter((item) => !item.projectId || item.projectId === projectId);
  return {
    ...store,
    projects: (store.projects || []).filter((item) => item.id === projectId),
    tasks: byProject(store.tasks || []),
    reviews: byProject(store.reviews || []),
    activities: byProject(store.activities || []),
    assignments: byProject(store.assignments || []),
    standups: byProject(store.standups || []),
    alerts: byProject(store.alerts || []),
    deliverables: byProject(store.deliverables || []),
    phases: byProject(store.phases || [])
  };
}

function attendanceKindLabel(kind) {
  return kind === 'meeting' ? '晚会出席' : '任务完成';
}

function attendanceStatusLabel(status) {
  return {
    normal: '正常',
    delayed: '延迟说明',
    reported_incomplete: '已汇报未完成/未按时出席',
    unreported_done: '未汇报但已完成/已出席',
    temp_leave: '临时请假/迟到',
    approved_leave: '提前请假',
    absent: '缺勤'
  }[status] || status;
}

export function createWeComRoutes({
  createId,
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  isWeComAvailable,
  sendWeComMarkdown,
  scanRisks,
  buildMetrics,
  todayText,
  normalizeStandup,
  normalizeTask,
  generateAssignmentBrief
}) {
  async function recordWeComAttendance(json = {}, url) {
    const store = await loadStore();
    const { projectId } = resolveProjectContext(store, url, json);
    const text = String(json?.text || json?.content || json?.message || '').trim();
    const parsed = parseAttendanceMessage(text);
    if (!parsed) return null;
    const record = normalizeAttendanceRecord({
      ...parsed,
      projectId,
      date: String(json?.date || url.searchParams.get('date') || todayText()).trim(),
      source: 'wecom'
    });
    await updateStore((draft) => {
      draft.attendanceRecords = draft.attendanceRecords || [];
      draft.attendanceRecords = draft.attendanceRecords.filter((item) => !(
        item.projectId === record.projectId
        && item.date === record.date
        && item.owner === record.owner
        && item.kind === record.kind
      ));
      draft.attendanceRecords.unshift(record);
      draft.attendanceRecords = draft.attendanceRecords.slice(0, 2000);
      return draft;
    });
    return {
      projectId,
      record,
      result: `已记录 ${record.owner} ${attendanceKindLabel(record.kind)}：${attendanceStatusLabel(record.status)}`
    };
  }

  return async function wecomRoutes(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/wecom/push') {
      if (!isWeComAvailable()) {
        sendError(res, 400, '未配置 WECOM_WEBHOOK_URL');
        return true;
      }
      const { json } = await readBody(req);
      const content = String(json?.content || '').trim();
      if (!content) {
        sendError(res, 400, '缺少 content 字段');
        return true;
      }
      const ok = await sendWeComMarkdown(content);
      sendJson(res, 200, { sent: ok });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/wecom/summary') {
      const store = await loadStore();
      const { projectId } = resolveProjectContext(store, url);
      const scopedStore = scopeStoreToProject(store, projectId);
      const alerts = scanRisks(scopedStore);
      sendJson(res, 200, {
        projectId,
        summary: buildWeComProjectSummary(scopedStore, alerts, buildMetrics),
        metrics: buildMetrics(scopedStore, alerts),
        alertCount: alerts.length,
        generatedAt: new Date().toISOString()
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/wecom/risks') {
      const store = await loadStore();
      const { projectId } = resolveProjectContext(store, url);
      const scopedStore = scopeStoreToProject(store, projectId);
      const alerts = scanRisks(scopedStore);
      sendJson(res, 200, {
        projectId,
        summary: buildWeComRiskSummary(scopedStore, alerts, buildMetrics),
        metrics: buildMetrics(scopedStore, alerts),
        alertCount: alerts.length,
        generatedAt: new Date().toISOString()
      });
      return true;
    }

    if (url.pathname === '/api/wecom/ranking' && (req.method === 'GET' || req.method === 'POST')) {
      const { json = {} } = req.method === 'POST' ? await readBody(req) : {};
      const store = await loadStore();
      const { projectId } = resolveProjectContext(store, url, json);
      const type = resolveRankingType(json?.type || url.searchParams.get('type') || 'daily') || 'daily';
      const date = String(json?.date || url.searchParams.get('date') || '').trim();
      const payload = buildWeComScoreRanking(store, { projectId, type, date, todayText });
      if ((json?.push || url.searchParams.get('push') === 'true') && isWeComAvailable()) {
        await sendWeComMarkdown(payload.summary);
      }
      sendJson(res, 200, { ...payload, result: payload.summary });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/wecom/command') {
      const { json } = await readBody(req);
      const text = String(json?.text || json?.content || json?.message || '').trim();
      const attendance = await recordWeComAttendance(json, url);
      if (attendance) {
        sendJson(res, 200, attendance);
        return true;
      }
      const type = resolveRankingType(text);
      if (type) {
        const store = await loadStore();
        const { projectId } = resolveProjectContext(store, url, json);
        const date = String(json?.date || '').trim();
        const payload = buildWeComScoreRanking(store, { projectId, type, date, todayText });
        if (json?.push && isWeComAvailable()) {
          await sendWeComMarkdown(payload.summary);
        }
        sendJson(res, 200, { ...payload, result: payload.summary });
        return true;
      }
      sendJson(res, 200, {
        result: '未识别指令。可发送：每日排名 / 每周排名 / 今日评分 / 周榜。'
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/wecom/attendance') {
      const { json } = await readBody(req);
      const attendance = await recordWeComAttendance(json, url);
      if (!attendance) {
        sendJson(res, 200, {
          result: '未识别考勤格式。请发送：姓名正常完成 / 姓名延迟完成 / 姓名正常出席 / 姓名延迟出席 / 姓名临时请假 / 姓名缺勤'
        });
        return true;
      }
      sendJson(res, 200, attendance);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/wecom/tasks') {
      const store = await loadStore();
      const { projectId } = resolveProjectContext(store, url);
      const scopedStore = scopeStoreToProject(store, projectId);
      const today = todayText();
      const claimedToday = new Set((scopedStore.assignments || []).filter((assignment) => assignment.date === today).map((assignment) => assignment.taskId));
      const active = (scopedStore.tasks || [])
        .filter((task) => task.status !== '已完成')
        .slice(0, 12)
        .map((task) => ({
          id: task.id,
          title: task.title,
          owner: task.owner || '未分配',
          progress: task.progress || 0,
          risk: task.risk || '低',
          due: task.due || '未设置',
          claimedToday: claimedToday.has(task.id)
        }));
      const lines = active.map((task, index) =>
        `${index + 1}. 【${task.risk}风险】${task.title}（${task.owner} · ${task.progress}% · 截止${task.due}）${task.claimedToday ? ' ✅已认领' : ''}`
      ).join('\n');
      const summary = active.length ? `当前 ${active.length} 个进行中任务：\n${lines}` : '暂无进行中任务。';
      sendJson(res, 200, { projectId, summary, result: summary, tasks: active });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/wecom/claim') {
      const { json } = await readBody(req);
      const owner = String(json?.owner || '').trim();
      const keyword = String(json?.taskKeyword || json?.taskTitle || json?.keyword || '').trim();
      if (!owner || !keyword) {
        sendJson(res, 200, { result: '❌ 请提供认领人姓名和任务关键词，例如：owner=田家铭 taskKeyword=TRTC' });
        return true;
      }
      const store = await loadStore();
      const { projectId } = resolveProjectContext(store, url, json);
      const scopedStore = scopeStoreToProject(store, projectId);
      const task = (scopedStore.tasks || []).find((item) =>
        item.status !== '已完成' && item.title.toLowerCase().includes(keyword.toLowerCase())
      );
      if (!task) {
        const candidates = (scopedStore.tasks || []).filter((item) => item.status !== '已完成').slice(0, 5)
          .map((item) => `「${item.title}」`).join('、');
        sendJson(res, 200, { result: `❌ 未找到包含「${keyword}」的进行中任务。当前可认领：${candidates || '暂无'}` });
        return true;
      }
      const today = todayText();
      const already = (scopedStore.assignments || []).find(
        (assignment) => assignment.owner === owner && assignment.taskId === task.id && assignment.date === today
      );
      if (already) {
        sendJson(res, 200, { result: `ℹ️ ${owner} 今日已认领「${task.title}」，无需重复认领。` });
        return true;
      }
      const assignment = bindAssignmentToExplicitRefs({
        id: createId('assign'),
        date: today,
        owner,
        taskId: task.id,
        taskTitle: task.title,
        projectId,
        note: '',
        status: '进行中',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, store);
      await updateStore((draft) => {
        draft.assignments = (draft.assignments || []).filter(
          (item) => !(item.owner === owner && item.taskId === task.id && item.date === today)
        );
        draft.assignments.unshift(assignment);
        return draft;
      });
      generateAssignmentBrief({ task, owner, note: '', store })
        .then((brief) => updateStore((draft) => {
          const idx = (draft.assignments || []).findIndex((item) => item.id === assignment.id);
          if (idx >= 0) {
            draft.assignments[idx].brief = brief;
            draft.assignments[idx].briefGeneratedBy = brief.generatedBy;
          }
          return draft;
        }))
        .catch((err) => console.error('[Brief/WeComClaim]', err.message));
      sendJson(res, 200, { result: `✅ ${owner} 已认领「${task.title}」，任务细则正在生成，稍后可在 Hub 查看。` });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/wecom/standup') {
      const { json } = await readBody(req);
      const owner = String(json?.owner || '').trim();
      if (!owner) {
        sendJson(res, 200, { result: '❌ 请提供成员姓名（owner 字段）' });
        return true;
      }
      const store = await loadStore();
      const { projectId } = resolveProjectContext(store, url, json);
      const standup = normalizeStandup({
        owner,
        yesterday: String(json?.yesterday || '').trim(),
        today: String(json?.today || '').trim(),
        blockers: String(json?.blockers || '无').trim(),
        projectId
      });
      await updateStore((draft) => {
        draft.standups = (draft.standups || []).filter(
          (item) => !(item.owner === owner && item.date === standup.date && (item.projectId || projectId) === projectId)
        );
        draft.standups.unshift(standup);
        draft.standups = draft.standups.slice(0, 500);
        return draft;
      });
      const blockerLine = standup.blockers && standup.blockers !== '无' ? `\n⚠️ 阻塞：${standup.blockers}` : '';
      sendJson(res, 200, { result: `✅ ${owner} 站会已提交（${standup.date}）\n昨日：${standup.yesterday || '未填写'}\n今日：${standup.today || '未填写'}${blockerLine}` });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/wecom/progress') {
      const { json } = await readBody(req);
      const keyword = String(json?.taskKeyword || json?.taskTitle || '').trim();
      const progress = Number(json?.progress ?? -1);
      const status = String(json?.status || '').trim();
      if (!keyword || (progress < 0 && !status)) {
        sendJson(res, 200, { result: '❌ 请提供任务关键词（taskKeyword）和进度（progress 0-100）或状态（status）' });
        return true;
      }
      const store = await loadStore();
      const { projectId } = resolveProjectContext(store, url, json);
      const scopedStore = scopeStoreToProject(store, projectId);
      const task = (scopedStore.tasks || []).find((item) => item.title.toLowerCase().includes(keyword.toLowerCase()));
      if (!task) {
        sendJson(res, 200, { result: `❌ 未找到包含「${keyword}」的任务` });
        return true;
      }
      const newProgress = progress >= 0 && progress <= 100 ? progress : task.progress;
      const newStatus = status || task.status;
      await updateStore((draft) => {
        const idx = (draft.tasks || []).findIndex((item) => item.id === task.id);
        if (idx >= 0) {
          draft.tasks[idx] = normalizeTask({ ...draft.tasks[idx], progress: newProgress, status: newStatus, progressSource: 'manual' });
        }
        return draft;
      });
      const parts = [];
      if (progress >= 0 && progress <= 100) parts.push(`进度 → ${newProgress}%`);
      if (status) parts.push(`状态 → ${newStatus}`);
      sendJson(res, 200, { result: `✅ 已更新「${task.title}」：${parts.join('，')}` });
      return true;
    }

    return false;
  };
}
