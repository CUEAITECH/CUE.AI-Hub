// server/adapters/wecom.js
// WeComAdapter：企业微信群机器人
// 包装现有 server/services/wecom.js，实现 NotificationAdapter 接口

import { NotificationAdapter } from './base.js';
import {
  isWeComAvailable,
  sendWeComMarkdown,
} from '../services/wecom.js';

export class WeComAdapter extends NotificationAdapter {
  get name() { return 'wecom'; }

  isAvailable() {
    return isWeComAvailable();
  }

  /**
   * 发送 Markdown 消息到企微群
   * 企微 Markdown 限制：
   * - 不支持表格（| 语法）
   * - 单条上限 4096 字节
   * - 支持 @成员（<@userId>）
   */
  async sendMarkdown(markdown, options = {}) {
    const { mentions = [] } = options;

    // 处理 @mention（企微格式：<@userId>）
    let content = markdown;
    if (mentions.length > 0) {
      const atList = mentions.map(h => `<@${h}>`).join(' ');
      content = `${atList}\n${content}`;
    }

    // 企微不支持表格：把 | 行转为列表
    content = this._stripTables(content);

    return sendWeComMarkdown(content);
  }

  /**
   * 发送卡片（企微降级为文字块）
   */
  async sendCard(card, options = {}) {
    const lines = [
      `### ${card.title}`,
      '',
      card.body,
    ];
    if (card.actions?.length) {
      lines.push('');
      for (const a of card.actions) {
        lines.push(`> [${a.label}](${a.url})`);
      }
    }
    return this.sendMarkdown(lines.join('\n'), options);
  }

  /**
   * 把 Markdown 表格转为列表（企微兼容）
   * 例：| A | B | → - **A**: B
   */
  _stripTables(text) {
    const lines = text.split('\n');
    const out = [];
    let inTable = false;
    let headers = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
        // 分隔行（|----|----）
        if (cells.every(c => /^-+$/.test(c))) { inTable = true; continue; }
        if (!inTable && headers.length === 0) {
          headers = cells;
          continue;
        }
        // 数据行
        if (headers.length > 0) {
          const parts = cells.map((c, i) => `**${headers[i] || ''}**: ${c}`);
          out.push('- ' + parts.join(' / '));
        } else {
          out.push('- ' + cells.join(' / '));
        }
      } else {
        if (inTable) { inTable = false; headers = []; }
        out.push(line);
      }
    }
    return out.join('\n');
  }
}
