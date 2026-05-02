/**
 * 企业微信群机器人 Webhook 推送
 * 配置：WECOM_WEBHOOK_URL 环境变量
 * 文档：https://developer.work.weixin.qq.com/document/path/91770
 */

export function isWeComAvailable() {
  return Boolean(process.env.WECOM_WEBHOOK_URL);
}

/**
 * 发送 Markdown 消息到企业微信群
 * @param {string} content - Markdown 格式内容
 * @returns {Promise<boolean>} 是否成功
 */
export async function sendWeComMarkdown(content) {
  const webhookUrl = process.env.WECOM_WEBHOOK_URL;
  if (!webhookUrl) return false;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: String(content).slice(0, 4096) }
      })
    });
    const result = await response.json();
    if (result.errcode !== 0) {
      console.error('[WeCom] 推送失败:', result.errmsg);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[WeCom] 推送异常:', err.message);
    return false;
  }
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
