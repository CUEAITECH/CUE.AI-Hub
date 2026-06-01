import logger from '../logger.js';
import { getTenantId } from '../services/auth.js';
export function createReportRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  buildMetrics,
  scanRisks,
  todayText,
  callClaude,
  isWeComAvailable,
  pushReport,
  sendWeComMarkdown,
  buildMeetingSummaryWeComMsg,
  generateEveningReport,
  hubUrl
}) {
  const getDateParam = (url) => url.searchParams.get('date') || todayText();

  return async function reportRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/reports/evening') {
      const store = await loadStore(getTenantId(req));
      const date = getDateParam(url);
      const entry = (store.eveningReports || {})[date];
      if (!entry) {
        sendJson(res, 200, { date, report: null, error: '该日暂无晚报记录' });
      } else {
        sendJson(res, 200, { date, ...entry });
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/reports/evening') {
      const { json } = await readBody(req);
      const date = json?.date || todayText();
      const finalEntry = await generateEveningReport(date);
      const updatedStore = await loadStore(getTenantId(req));
      const alerts = updatedStore.alerts || [];
      sendJson(res, 201, {
        date,
        report: finalEntry,
        wecomSent: isWeComAvailable(),
        tasks: updatedStore.tasks,
        currentStage: updatedStore.currentStage,
        alerts,
        metrics: buildMetrics(updatedStore, alerts)
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/reports/daily') {
      const store = await loadStore(getTenantId(req));
      const today = todayText();
      const alerts = scanRisks(store);
      const metrics = buildMetrics(store, alerts);
      const todayStandups = (store.standups || []).filter((standup) => standup.date === today);
      const recentReviews = (store.reviews || []).slice(0, 10);
      const activeTasks = (store.tasks || []).filter((task) => task.status !== '已完成');

      const systemPrompt = `你是 CUE Project Hub 的 AI 报告生成器，专为技术负责人和产品负责人生成简洁的研发日报。
报告结构（Markdown 格式）：
1. **今日交付概况**：健康度评分、核心指标（风险任务/待审阅/告警数）
2. **任务进展**：列出进行中和高风险任务的状态
3. **代码审阅摘要**：今日 Review 结论（阻断/警告数量）
4. **站会要点**：团队动态、阻塞项（如有站会数据）
5. **风险与行动项**：P1/P2 告警，建议行动
报告要简洁专业，用中文，总长不超过 600 字。`;

      const userPrompt = `生成 ${today} 的研发日报。

数据如下：
健康度：${metrics.healthScore ?? 0} 分
高风险任务：${metrics.highRiskTasks ?? 0} 个
待审阅：${metrics.pendingReviews ?? 0} 个
紧急告警：${metrics.urgentAlerts ?? 0} 个

进行中任务（前10条）：
${activeTasks.slice(0, 10).map((task) => `- [${task.status}] ${task.title}（${task.owner}）进度 ${task.progress}% 风险:${task.risk}`).join('\n')}

最近 AI Review：
${recentReviews.map((review) => `- ${review.level} | ${review.title}（${review.owner}）分数:${review.score}`).join('\n')}

今日站会（${todayStandups.length} 人回复）：
${todayStandups.length ? todayStandups.map((standup) => `- ${standup.owner}：${standup.blockers ? '阻塞：' + standup.blockers : '无阻塞'}`).join('\n') : '暂无站会记录'}

P1 告警：
${alerts.filter((alert) => alert.severity === 'P1').map((alert) => `- ${alert.title}：${alert.detail}`).join('\n') || '无'}`;

      const report = await callClaude(systemPrompt, userPrompt) ||
        `# ${today} 研发日报\n\n健康度：${metrics.healthScore ?? 0} 分\n高风险任务：${metrics.highRiskTasks ?? 0} 个\n\n（LLM 生成失败，显示基础数据）`;

      await updateStore((draft) => {
        draft.reports = draft.reports || {};
        draft.reports[today] = { report, generatedAt: new Date().toISOString() };
        return draft;
      }, getTenantId(req));

      let wecomSent = false;
      if (isWeComAvailable()) {
        wecomSent = await pushReport(`# ${today} 研发日报\n\n${report}`);
      }

      sendJson(res, 200, { date: today, report, wecomSent });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/reports/compare') {
      const store = await loadStore(getTenantId(req));
      const date = url.searchParams.get('date') || todayText();
      const eveningEntry = (store.eveningReports || {})[date];
      if (!eveningEntry) {
        sendJson(res, 200, { date, error: '该日无晚报记录，请先生成晚报' });
        return true;
      }

      const snapshotAssignments = eveningEntry.assignments || [];
      const snapshotCommits = eveningEntry.commits || [];
      const systemPrompt = `你是 CUE Project Hub 的对照分析 AI。根据当日晚报中记录的任务分工快照和实际 GitHub commit 记录，生成对照分析报告（Markdown）。
对每个分工领取：判断是否有对应的 commit（通过提交者姓名匹配）。
输出格式：
1. **完成情况总览**：X 人领取，Y 人有 commit 支撑，Z 人无 commit 记录
2. **逐条对照**：每个分工 → 完成 / 遗漏
3. **结论**：需要跟进的成员和任务`;

      const assignmentLines = snapshotAssignments.length
        ? snapshotAssignments.map((assignment) => `- ${assignment.owner} 领取「${assignment.taskTitle}」状态:${assignment.status}`).join('\n')
        : '无分工记录';
      const commitLines = snapshotCommits.length
        ? snapshotCommits.map((commit) => `- ${commit.owner || commit.actor || '未知'}: ${commit.title}`).join('\n')
        : '无 commit 记录（晚报快照时刻）';

      const comparison = await callClaude(
        systemPrompt,
        `${date} 晚报分工快照：\n${assignmentLines}\n\n快照时刻 commit 记录：\n${commitLines}`
      ) || `# ${date} 对照分析\n\n分工：${snapshotAssignments.length} 条，提交：${snapshotCommits.length} 条\n\n（LLM 生成失败）`;

      sendJson(res, 200, { date, comparison, assignments: snapshotAssignments, commits: snapshotCommits });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/reports/meeting-summary') {
      const { json } = await readBody(req);
      const date = json?.date || todayText();
      const store = await loadStore(getTenantId(req));

      const todayAssignments = (store.assignments || []).filter((assignment) => assignment.date === date);
      const eveningEntry = (store.eveningReports || {})[date];
      const nextTargets = eveningEntry?.nextTargets || [];

      const systemPrompt = `你是 CUE Project Hub 的晚会总结 AI。根据今日晚会的分工领取情况，生成简洁的会后总结。
格式（纯 Markdown 列表，无表格，总长不超过 300 字）：
## 今日分工
- 成员名 → 「任务标题」
（逐条列出，每人一行）
## 明日重点
（2-3 条最重要的技术目标）
## 待跟进
（有风险或未领取的，无则省略）
要求：语言简洁，适合企业微信群消息。`;

      const assignmentLines = todayAssignments.length
        ? todayAssignments.map((assignment) => `- ${assignment.owner} → 「${assignment.taskTitle}」（${assignment.status}）`).join('\n')
        : '今日暂无分工记录';
      const targetLines = nextTargets.slice(0, 6)
        .map((target) => `- ${target.priority} ${target.owner}：${target.taskTitle}`).join('\n') || '';

      const summaryText = await callClaude(
        systemPrompt,
        `${date} 晚会分工（共 ${todayAssignments.length} 条）：\n${assignmentLines}${
          targetLines ? `\n\n晚报建议关注：\n${targetLines}` : ''
        }`
      );

      await updateStore((draft) => {
        draft.reports = draft.reports || {};
        draft.reports[date] = {
          ...(draft.reports[date] || {}),
          meetingSummary: summaryText || '',
          meetingSummaryAt: new Date().toISOString()
        };
        return draft;
      }, getTenantId(req));

      let wecomSent = false;
      if (isWeComAvailable()) {
        const wecomMsg = buildMeetingSummaryWeComMsg(date, todayAssignments, summaryText || '', hubUrl);
        wecomSent = await sendWeComMarkdown(wecomMsg).catch((err) => {
          logger.error('[WeCom] 会后总结推送失败:', err.message);
          return false;
        });
      }

      sendJson(res, 200, {
        date,
        summary: summaryText || '',
        assignmentCount: todayAssignments.length,
        wecomSent
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/reports/meeting-summary') {
      const store = await loadStore(getTenantId(req));
      const date = url.searchParams.get('date') || todayText();
      const dayReport = (store.reports || {})[date] || {};
      sendJson(res, 200, {
        date,
        summary: dayReport.meetingSummary || null,
        generatedAt: dayReport.meetingSummaryAt || null
      });
      return true;
    }

    return false;
  };
}
