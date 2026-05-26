// server/adapters/slack.js
// SlackAdapter — W15 完整实现
// 支持 Incoming Webhook（群机器人）+ Bot Token（Web API）
//
// Incoming Webhook：最简单，只需 SLACK_WEBHOOK_URL
// Bot Token：需要 SLACK_BOT_TOKEN + SLACK_DEFAULT_CHANNEL，支持指定频道
//
// 消息格式：
//   sendMarkdown → Block Kit mrkdwn section
//   sendCard     → Header + Section + Actions（Button blocks）

import { NotificationAdapter } from './base.js';
import logger from '../logger.js';


// Slack mrkdwn 转换规则（与标准 Markdown 差异）
function toSlackMrkdwn(markdown) {
  return markdown
    // 标题 ### → *bold*
    .replace(/^#{1,3}\s+(.+)$/gm, '*$1*')
    // **bold** → *bold* （Slack 用单星）
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    // __bold__ → *bold*
    .replace(/__(.+?)__/g, '*$1*')
    // _italic_ → _italic_ (already compatible)
    // `code` → `code` (compatible)
    // [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    // ~~strike~~ → ~strike~
    .replace(/~~(.+?)~~/g, '~$1~')
    // 企微表格不支持，这里保留原样（Block Kit 支持有限，纯文本更好）
    ;
}

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

  /**
   * 发送 Markdown 消息（转换为 Slack mrkdwn Block Kit）
   */
  async sendMarkdown(markdown, options = {}) {
    const { mentions = [], urgency = 'normal' } = options;

    let text = toSlackMrkdwn(markdown);

    // @mention 处理：在消息前添加（需要 Slack user ID 或 @handle）
    if (mentions.length > 0) {
      const atList = mentions.map(h => `<@${h}>`).join(' ');
      text = `${atList}\n${text}`;
    }

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: text.slice(0, 3000) }, // Block Kit 限制 3000 chars
      },
    ];

    // 高紧急度添加 emoji 标记
    if (urgency === 'high') {
      blocks.unshift({
        type: 'header',
        text: { type: 'plain_text', text: '🚨 紧急通知', emoji: true },
      });
    }

    const payload = {
      text: text.slice(0, 150), // fallback text for notifications
      blocks,
    };

    return this._send(payload, options.channel);
  }

  /**
   * 发送结构化卡片消息（Block Kit Header + Section + Actions）
   */
  async sendCard(card, options = {}) {
    const blocks = [];

    // Header block
    if (card.title) {
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: card.title.slice(0, 150), emoji: true },
      });
    }

    // Body section
    if (card.body) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: toSlackMrkdwn(card.body).slice(0, 3000) },
      });
    }

    // Divider
    if (card.actions?.length) {
      blocks.push({ type: 'divider' });

      // Actions block（最多 5 个 button）
      const elements = card.actions.slice(0, 5).map(action => ({
        type: 'button',
        text: { type: 'plain_text', text: action.label.slice(0, 75), emoji: true },
        url: action.url,
        action_id: `action_${Math.random().toString(36).slice(2, 8)}`,
      }));

      blocks.push({ type: 'actions', elements });
    }

    const payload = {
      text: card.title || 'CUE Hub 通知',
      blocks,
    };

    return this._send(payload, options.channel);
  }

  /**
   * 解析 handle → Slack user ID（需要 Bot Token）
   * 生产环境通过 users.lookupByEmail 或 users.list 实现
   */
  async resolveHandle(handle) {
    if (!this._botToken) return null;
    // Simplified: return handle as-is if it looks like a Slack ID
    if (/^U[A-Z0-9]{8,}$/i.test(handle)) return handle;
    return null;
  }

  // ─── 内部发送方法 ─────────────────────────────────────────────

  /**
   * 通过 Incoming Webhook 发送（优先），或 Bot Token chat.postMessage
   */
  async _send(payload, channel) {
    if (this._webhookUrl) {
      return this._sendViaWebhook(payload);
    }
    if (this._botToken) {
      return this._sendViaApi(payload, channel || this._defaultChannel);
    }
    return false;
  }

  async _sendViaWebhook(payload) {
    try {
      const body = JSON.stringify(payload);
      const url = new URL(this._webhookUrl);
      const mod = url.protocol === 'https:' ? await import('https') : await import('http');

      return new Promise((resolve) => {
        const req = mod.request(
          {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              if (res.statusCode === 200 && data === 'ok') {
                resolve(true);
              } else {
                logger.warn(`[SlackAdapter] webhook error ${res.statusCode}: ${data}`);
                resolve(false);
              }
            });
          }
        );
        req.on('error', (e) => {
          logger.error('[SlackAdapter] webhook request error:', e.message);
          resolve(false);
        });
        req.write(body);
        req.end();
      });
    } catch (e) {
      logger.error('[SlackAdapter] sendViaWebhook error:', e.message);
      return false;
    }
  }

  async _sendViaApi(payload, channel) {
    try {
      const body = JSON.stringify({ ...payload, channel });
      const https = await import('https');

      return new Promise((resolve) => {
        const req = https.request(
          {
            hostname: 'slack.com',
            path: '/api/chat.postMessage',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this._botToken}`,
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (json.ok) {
                  resolve(true);
                } else {
                  logger.warn(`[SlackAdapter] API error: ${json.error}`);
                  resolve(false);
                }
              } catch {
                resolve(false);
              }
            });
          }
        );
        req.on('error', (e) => {
          logger.error('[SlackAdapter] API request error:', e.message);
          resolve(false);
        });
        req.write(body);
        req.end();
      });
    } catch (e) {
      logger.error('[SlackAdapter] sendViaApi error:', e.message);
      return false;
    }
  }
}
