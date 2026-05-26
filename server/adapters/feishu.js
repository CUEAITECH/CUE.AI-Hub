// server/adapters/feishu.js
// FeishuAdapter — W15 完整实现
// 飞书（Lark）群机器人 Webhook
//
// 支持消息类型：
//   text       — 纯文本（最简单，兼容性最好）
//   post       — 富文本（支持粗体、链接、@人）
//   interactive — 卡片消息（支持按钮、多列、标题）
//
// 环境变量：FEISHU_WEBHOOK_URL

import { NotificationAdapter } from './base.js';
import logger from '../logger.js';


// 飞书 post 富文本节点构建器
function textNode(content) {
  return { tag: 'text', text: content };
}
function boldNode(content) {
  return { tag: 'text', text: content, style: ['bold'] };
}
function linkNode(text, href) {
  return { tag: 'a', text, href };
}
function atNode(userId) {
  return { tag: 'at', user_id: userId };
}

/**
 * 将 Markdown 解析为飞书 post 富文本节点数组（每行一个 paragraph）
 * 支持：**bold**、[text](url)、### 标题、普通文本
 */
function markdownToPostContent(markdown) {
  const lines = markdown.split('\n');
  const content = [];

  for (const line of lines) {
    if (!line.trim()) {
      // 空行 → 空段落（保持间距）
      content.push([]);
      continue;
    }

    const paragraph = [];
    let remaining = line;

    // 处理标题（### → 粗体）
    const headingMatch = remaining.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      paragraph.push(boldNode(headingMatch[1]));
      content.push(paragraph);
      continue;
    }

    // 处理行内格式（**bold**、[text](url)）
    const inlineRegex = /(\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\))/g;
    let lastIndex = 0;
    let match;

    while ((match = inlineRegex.exec(remaining)) !== null) {
      // 前置纯文本
      if (match.index > lastIndex) {
        paragraph.push(textNode(remaining.slice(lastIndex, match.index)));
      }

      if (match[0].startsWith('**')) {
        // Bold
        paragraph.push(boldNode(match[2]));
      } else {
        // Link
        paragraph.push(linkNode(match[3], match[4]));
      }

      lastIndex = match.index + match[0].length;
    }

    // 尾部纯文本
    if (lastIndex < remaining.length) {
      paragraph.push(textNode(remaining.slice(lastIndex)));
    }

    if (paragraph.length === 0) {
      paragraph.push(textNode(line));
    }

    content.push(paragraph);
  }

  return content;
}

export class FeishuAdapter extends NotificationAdapter {
  constructor({ webhookUrl } = {}) {
    super();
    this._webhookUrl = webhookUrl || process.env.FEISHU_WEBHOOK_URL;
  }

  get name() { return 'feishu'; }

  isAvailable() {
    return Boolean(this._webhookUrl);
  }

  /**
   * 发送 Markdown 消息（转为飞书 post 富文本格式）
   *
   * 飞书 post 格式支持：粗体、链接、@人
   * 降级策略：如果 post 格式失败，退回纯文本
   */
  async sendMarkdown(markdown, options = {}) {
    const { mentions = [], urgency = 'normal' } = options;

    // 构建 post 富文本内容
    const content = markdownToPostContent(markdown);

    // @mention：在第一段前插入
    if (mentions.length > 0) {
      const atParagraph = mentions.map(h => atNode(h));
      content.unshift(atParagraph);
    }

    // 紧急消息添加标题
    const title = urgency === 'high' ? '🚨 紧急通知' : 'CUE Hub';

    const payload = {
      msg_type: 'post',
      content: {
        post: {
          zh_cn: {
            title,
            content,
          },
        },
      },
    };

    const ok = await this._postWebhook(payload);
    if (!ok) {
      // 降级：纯文本
      return this._sendText(markdown);
    }
    return ok;
  }

  /**
   * 发送结构化卡片消息（飞书 Interactive Card）
   *
   * 飞书卡片结构：header + body (div element) + actions
   * 参考：https://open.feishu.cn/document/ukTMukTMukTM/ugTNwUjL4UDM14CO1ATN
   */
  async sendCard(card, options = {}) {
    const elements = [];

    // Body 文本（转为 markdown div）
    if (card.body) {
      elements.push({
        tag: 'div',
        text: {
          content: card.body,
          tag: 'lark_md',
        },
      });
    }

    // 操作按钮
    if (card.actions?.length) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'action',
        actions: card.actions.slice(0, 4).map(action => ({
          tag: 'button',
          text: { content: action.label, tag: 'plain_text' },
          type: 'default',
          url: action.url,
        })),
      });
    }

    const payload = {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: {
            content: card.title || 'CUE Hub',
            tag: 'plain_text',
          },
          template: 'blue',
        },
        elements,
      },
    };

    const ok = await this._postWebhook(payload);
    if (!ok) {
      // 降级为 Markdown
      return this.sendMarkdown(`**${card.title}**\n\n${card.body}`, options);
    }
    return ok;
  }

  // ─── 内部方法 ─────────────────────────────────────────────────

  async _sendText(text) {
    const payload = {
      msg_type: 'text',
      content: { text: text.slice(0, 4096) },
    };
    return this._postWebhook(payload);
  }

  async _postWebhook(payload) {
    if (!this._webhookUrl) return false;

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
              try {
                const json = JSON.parse(data);
                // 飞书成功：code=0 或 StatusCode=0
                if (json.code === 0 || json.StatusCode === 0) {
                  resolve(true);
                } else {
                  logger.warn(`[FeishuAdapter] API error code=${json.code}: ${json.msg || JSON.stringify(json)}`);
                  resolve(false);
                }
              } catch {
                // 非 JSON 响应
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  resolve(true);
                } else {
                  logger.warn(`[FeishuAdapter] HTTP ${res.statusCode}: ${data}`);
                  resolve(false);
                }
              }
            });
          }
        );
        req.on('error', (e) => {
          logger.error('[FeishuAdapter] request error:', e.message);
          resolve(false);
        });
        req.write(body);
        req.end();
      });
    } catch (e) {
      logger.error('[FeishuAdapter] postWebhook error:', e.message);
      return false;
    }
  }
}
