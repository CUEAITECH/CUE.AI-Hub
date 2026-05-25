import logger from '../logger.js';
import { Eta } from 'eta';

/**
 * 企业微信群机器人 Webhook 推送
 * 配置：WECOM_WEBHOOK_URL 环境变量
 * 文档：https://developer.work.weixin.qq.com/document/path/91770
 *
 * 注意：企业微信 Markdown 不支持表格，每条消息上限 4096 字节。
 * 本文件提供的格式化函数会将结构化数据转为企微兼容的纯 Markdown 列表。
 * 所有消息文本均通过 Eta 模板生成，与 dailyBrief.js 风格统一。
 */

const eta = new Eta({ cache: false, views: '.' });

// ─── Eta 模板 ─────────────────────────────────────────────────────────────────

/** 晚会前作战包（17:45 自动推送） */
const PRE_MEETING_WECOM_TEMPLATE = `# 🗓️ <%=it.date%> 晚会前作战包

阶段进度：**<%=it.stageProgress%>%** | 提交：<%=it.commitCount%> 条 | Block Review：<%=it.blockCount%> 条

## 昨日分工对账
<%if(it.prSummaryLine){%>
<%=it.prSummaryLine%>

<%}%><%=it.reconLines%>

## 晚会待处理

<%=it.attentionLines%>

## 今晚可认领任务

<%=it.targetLines%>

👉 [在 hub 领取今日分工](<%=it.hubUrl%>) | 领取后自动记录，会后生成总结`;

/** 晚会后总结（有 LLM 摘要时） */
const MEETING_SUMMARY_LLM_TEMPLATE = `# ✅ <%=it.date%> 晚会后总结

<%=it.summaryText%>

📋 [查看详情](<%=it.hubUrl%>)`;

/** 晚会后总结（降级：纯分工列表） */
const MEETING_SUMMARY_LIST_TEMPLATE = `# ✅ <%=it.date%> 晚会后总结

## 今日分工（共 <%=it.count%> 人领取）

<%=it.assignLines%>

📋 [查看详情](<%=it.hubUrl%>) · 有提交请关联任务 ID`;

/** P1 风险告警 */
const RISK_ALERT_WECOM_TEMPLATE = `# 🚨 CUE 项目风险告警
> 发现 **<%=it.count%>** 个 P1 级风险，请立即处理

<%it.alerts.forEach(function(a){%>**<%=a.severity%>** <%=a.title%>
> <%=a.detail%>
> 提醒对象：<%=a.target%>

<%})%>`;

// ─── 基础发送 ──────────────────────────────────────────────────────────────────

export function isWeComAvailable() {
  return Boolean(process.env.WECOM_WEBHOOK_URL);
}

/**
 * 发送 Markdown 消息到企业微信群
 * @param {string} content - Markdown 格式内容（企微子集，无表格）
 * @returns {Promise<boolean>} 是否成功
 */
export async function sendWeComMarkdown(content) {
  const webhookUrl = process.env.WECOM_WEBHOOK_URL;
  if (!webhookUrl) return false;

  // 企微单条限制 4096 字节，截断时保留链接尾
  const safe = String(content).slice(0, 4000);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: safe }
      })
    });
    const result = await response.json();
    if (result.errcode !== 0) {
      logger.error('[WeCom] 推送失败:', result.errmsg, '(errcode:', result.errcode, ')');
      return false;
    }
    logger.info('[WeCom] 推送成功');
    return true;
  } catch (err) {
    logger.error('[WeCom] 推送异常:', err.message);
    return false;
  }
}

// ─── 消息构建（全量 eta 模板）────────────────────────────────────────────────

/**
 * 生成晚会前作战包（企微格式，无表格）
 * 在 17:45 自动推送，供团队提前了解对账情况
 *
 * @param {object} eveningEntry - generateEveningReport 返回的完整 entry
 * @param {string} hubUrl - hub 地址，用于附加链接
 * @returns {string} 企微 Markdown 字符串
 */
export function buildPreMeetingWeComMsg(eveningEntry, hubUrl = 'https://hub.cueai.top') {
  const date           = eveningEntry.date || '';
  const summary        = eveningEntry.summary || {};
  const reconciliation = eveningEntry.reconciliation || [];
  const nextTargets    = eveningEntry.nextTargets || [];
  const pulls          = eveningEntry.pulls || [];

  // PR 汇总行（仅当有 PR 数据时插入）
  const openPulls   = pulls.filter(p => p.state === 'open').length;
  const mergedPulls = pulls.filter(p => p.state === 'merged').length;
  const blockPulls  = pulls.filter(p => p.hubReview?.level === 'Block' || p.hubReview?.level === 'Escalate').length;
  const prSummaryLine = pulls.length > 0
    ? `📋 今日 PR 汇总\n  已合并：${mergedPulls} 个  |  待 review：${openPulls} 个  |  Block：${blockPulls} 个`
    : '';

  // 分工对账列表
  const reconLines = reconciliation.length
    ? reconciliation.map(row => {
        const icon = row.completed ? '✅' : row.commitCount > 0 ? '🔶' : '⚠️';
        return `- ${icon} **${row.owner}**：「${row.taskTitle}」${row.result}`;
      }).join('\n')
    : '> 暂无昨日分工记录';

  // 待晚会处理项
  const needsAttention = reconciliation.filter(r => !r.completed);
  const attentionLines = needsAttention.length
    ? needsAttention.slice(0, 5).map(r => {
        const action = r.commitCount > 0 ? '确认剩余验收项' : '拆分/转派/标记阻塞';
        return `- 「${r.taskTitle}」（${r.owner}）→ ${action}`;
      }).join('\n')
    : '- 无待处理项';

  // 明日候选任务
  const targetLines = nextTargets.slice(0, 4)
    .map(t => `- **${t.priority}** ${t.owner}：${t.taskTitle}`)
    .join('\n') || '- 晚会上认领后更新';

  return eta.renderString(PRE_MEETING_WECOM_TEMPLATE, {
    date,
    stageProgress: summary.stageProgress ?? 0,
    commitCount:   summary.commitCount   ?? 0,
    blockCount:    summary.blockReviewCount ?? 0,
    prSummaryLine,
    reconLines,
    attentionLines,
    targetLines,
    hubUrl,
  });
}

/**
 * 生成晚会后总结（企微格式）
 * 手动触发，推送今日分工结果
 *
 * @param {string} date
 * @param {Array} assignments - 今日领取记录
 * @param {string} summaryText - LLM 生成的总结文字（可选，降级用分工列表）
 * @param {string} hubUrl
 * @returns {string}
 */
export function buildMeetingSummaryWeComMsg(date, assignments, summaryText = '', hubUrl = 'https://hub.cueai.top') {
  const assignLines = assignments.length
    ? assignments.map(a => `- **${a.owner}** → 「${a.taskTitle}」`).join('\n')
    : '- 暂无领取记录（请在 hub 补录）';

  if (summaryText && summaryText.length > 30) {
    return eta.renderString(MEETING_SUMMARY_LLM_TEMPLATE, { date, summaryText, hubUrl });
  }

  return eta.renderString(MEETING_SUMMARY_LIST_TEMPLATE, {
    date,
    count: assignments.length,
    assignLines,
    hubUrl,
  });
}

/**
 * 推送风险告警到企业微信
 * @param {Array} alerts - 风险告警列表
 */
export async function pushRiskAlerts(alerts) {
  const p1Alerts = alerts.filter(a => a.severity === 'P1');
  if (!p1Alerts.length) return false;

  const msg = eta.renderString(RISK_ALERT_WECOM_TEMPLATE, {
    count:  p1Alerts.length,
    alerts: p1Alerts,
  });

  return sendWeComMarkdown(msg);
}

/**
 * 推送日报/周报到企业微信
 * @param {string} reportMarkdown - 报告 Markdown 内容
 */
export async function pushReport(reportMarkdown) {
  return sendWeComMarkdown(reportMarkdown);
}
