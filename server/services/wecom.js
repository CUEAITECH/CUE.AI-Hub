/**
 * 企业微信群机器人 Webhook 推送
 * 配置：WECOM_WEBHOOK_URL 环境变量
 * 文档：https://developer.work.weixin.qq.com/document/path/91770
 *
 * 注意：企业微信 Markdown 不支持表格，每条消息上限 4096 字节。
 * 本文件提供的格式化函数会将结构化数据转为企微兼容的纯 Markdown 列表。
 */

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
      console.error('[WeCom] 推送失败:', result.errmsg, '(errcode:', result.errcode, ')');
      return false;
    }
    console.log('[WeCom] 推送成功');
    return true;
  } catch (err) {
    console.error('[WeCom] 推送异常:', err.message);
    return false;
  }
}

/**
 * 生成晚会前作战包（企微格式，无表格）
 * 在 17:45 自动推送，供团队提前了解对账情况
 *
 * @param {object} eveningEntry - generateEveningReport 返回的完整 entry
 * @param {string} hubUrl - hub 地址，用于附加链接
 * @returns {string} 企微 Markdown 字符串
 */
export function buildPreMeetingWeComMsg(eveningEntry, hubUrl = 'https://hub.cueai.top') {
  const date = eveningEntry.date || '';
  const summary = eveningEntry.summary || {};
  const reconciliation = eveningEntry.reconciliation || [];
  const nextTargets = eveningEntry.nextTargets || [];

  // ── 分工对账列表 ──────────────────────────────────────────────
  const reconLines = reconciliation.length
    ? reconciliation.map((row) => {
        const icon = row.completed ? '✅' : row.commitCount > 0 ? '🔶' : '⚠️';
        return `- ${icon} **${row.owner}**：「${row.taskTitle}」${row.result}`;
      }).join('\n')
    : '> 暂无昨日分工记录';

  // ── 待晚会处理 ────────────────────────────────────────────────
  const needsAttention = reconciliation.filter((r) => !r.completed);
  const attentionLines = needsAttention.length
    ? needsAttention.slice(0, 5).map((r) => {
        const action = r.commitCount > 0 ? '确认剩余验收项' : '拆分/转派/标记阻塞';
        return `- 「${r.taskTitle}」（${r.owner}）→ ${action}`;
      }).join('\n')
    : '- 无待处理项';

  // ── 明日候选任务 ──────────────────────────────────────────────
  const targetLines = nextTargets.slice(0, 4).map((t) =>
    `- **${t.priority}** ${t.owner}：${t.taskTitle}`
  ).join('\n') || '- 晚会上认领后更新';

  const lines = [
    `# 🗓️ ${date} 晚会前作战包`,
    '',
    `阶段进度：**${summary.stageProgress ?? 0}%** | 提交：${summary.commitCount ?? 0} 条 | Block Review：${summary.blockReviewCount ?? 0} 条`,
    '',
    '## 昨日分工对账',
    reconLines,
    '',
    '## 晚会待处理',
    attentionLines,
    '',
    '## 今晚可认领任务',
    targetLines,
    '',
    `👉 [在 hub 领取今日分工](${hubUrl}) | 领取后自动记录，会后生成总结`
  ];

  return lines.join('\n');
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
    ? assignments.map((a) => `- **${a.owner}** → 「${a.taskTitle}」`).join('\n')
    : '- 暂无领取记录（请在 hub 补录）';

  if (summaryText && summaryText.length > 30) {
    // 有 LLM 总结时直接用，但包一个头部
    return [
      `# ✅ ${date} 晚会后总结`,
      '',
      summaryText,
      '',
      `📋 [查看详情](${hubUrl})`
    ].join('\n');
  }

  // 降级：纯分工列表
  return [
    `# ✅ ${date} 晚会后总结`,
    '',
    `## 今日分工（共 ${assignments.length} 人领取）`,
    assignLines,
    '',
    `📋 [查看详情](${hubUrl}) · 有提交请关联任务 ID`
  ].join('\n');
}

/**
 * 推送风险告警到企业微信
 * @param {Array} alerts - 风险告警列表
 */
export async function pushRiskAlerts(alerts) {
  const p1Alerts = alerts.filter((a) => a.severity === 'P1');
  if (!p1Alerts.length) return false;

  const lines = [
    '# 🚨 CUE 项目风险告警',
    `> 发现 **${p1Alerts.length}** 个 P1 级风险，请立即处理`,
    ''
  ];

  for (const alert of p1Alerts) {
    lines.push(`**${alert.severity}** ${alert.title}`);
    lines.push(`> ${alert.detail}`);
    lines.push(`> 提醒对象：${alert.target}`);
    lines.push('');
  }

  return sendWeComMarkdown(lines.join('\n'));
}

/**
 * 推送日报/周报到企业微信
 * @param {string} reportMarkdown - 报告 Markdown 内容
 */
export async function pushReport(reportMarkdown) {
  return sendWeComMarkdown(reportMarkdown);
}
