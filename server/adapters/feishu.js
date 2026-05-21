// server/adapters/feishu.js
// FeishuAdapter — W15 实现，当前为 stub
// 飞书（Lark）群机器人 + Interactive Card

import { NotificationAdapter } from './base.js';

export class FeishuAdapter extends NotificationAdapter {
  constructor({ webhookUrl } = {}) {
    super();
    this._webhookUrl = webhookUrl || process.env.FEISHU_WEBHOOK_URL;
  }

  get name() { return 'feishu'; }

  isAvailable() {
    return Boolean(this._webhookUrl);
  }

  async sendMarkdown(markdown, options = {}) {
    // TODO W15: Implement Feishu custom robot
    // 飞书支持 post 格式（富文本）和 interactive card
    console.warn('[FeishuAdapter] not yet implemented (W15)');
    return false;
  }

  async sendCard(card, options = {}) {
    // TODO W15: Implement Feishu Interactive Card
    console.warn('[FeishuAdapter] not yet implemented (W15)');
    return false;
  }
}
