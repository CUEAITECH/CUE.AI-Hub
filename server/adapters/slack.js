// server/adapters/slack.js
// SlackAdapter — W15 实现，当前为 stub
// 愿景：团队用什么，Hub 就接入什么

import { NotificationAdapter } from './base.js';

export class SlackAdapter extends NotificationAdapter {
  constructor({ webhookUrl, botToken, defaultChannel } = {}) {
    super();
    this._webhookUrl = webhookUrl || process.env.SLACK_WEBHOOK_URL;
    this._botToken = botToken || process.env.SLACK_BOT_TOKEN;
    this._defaultChannel = defaultChannel || process.env.SLACK_DEFAULT_CHANNEL || '#general';
  }

  get name() { return 'slack'; }

  isAvailable() {
    return Boolean(this._webhookUrl || this._botToken);
  }

  async sendMarkdown(markdown, options = {}) {
    // TODO W15: Implement Slack Block Kit
    // Slack 支持 mrkdwn 格式（与标准 MD 略有差异）
    // 富文本用 Block Kit，简单消息用 incoming webhook
    console.warn('[SlackAdapter] not yet implemented (W15)');
    return false;
  }

  async sendCard(card, options = {}) {
    // TODO W15: Implement Block Kit section/button blocks
    console.warn('[SlackAdapter] not yet implemented (W15)');
    return false;
  }

  async resolveHandle(handle) {
    // TODO W15: Slack users.lookupByEmail or users.list
    return null;
  }
}
