// server/adapters/base.js
// NotificationAdapter 接口定义
// 愿景：Hub 工作在通信平台之上，不依赖任何一个
// 任何平台只需实现这个接口即可接入

/**
 * NotificationAdapter 基类
 * 子类实现：WeComAdapter / SlackAdapter / FeishuAdapter / EmailAdapter
 */
export class NotificationAdapter {
  /** @returns {string} 适配器名称（用于日志和诊断） */
  get name() { return 'base'; }

  /** @returns {boolean} 当前配置下是否可用 */
  isAvailable() { return false; }

  /**
   * 发送 Markdown 格式消息（适配器内部处理格式差异）
   * @param {string} markdown - 源 Markdown（不含平台特定语法）
   * @param {object} [options]
   * @param {string} [options.channel]    - 目标频道/群（可选，未指定则用默认）
   * @param {string[]} [options.mentions]  - 需要 @的 actor comm_handle 列表
   * @param {string} [options.urgency]    - 'high'|'normal'|'low'
   * @returns {Promise<boolean>} 是否成功
   */
  async sendMarkdown(markdown, options = {}) {
    throw new Error(`${this.name}.sendMarkdown not implemented`);
  }

  /**
   * 发送结构化通知（卡片式，有标题/正文/操作按钮）
   * 平台不支持卡片时降级为 Markdown
   * @param {object} card
   * @param {string} card.title
   * @param {string} card.body
   * @param {Array<{label: string, url: string}>} [card.actions]
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async sendCard(card, options = {}) {
    // 默认降级为 Markdown
    const lines = [`**${card.title}**`, '', card.body];
    if (card.actions?.length) {
      lines.push('');
      for (const a of card.actions) lines.push(`[${a.label}](${a.url})`);
    }
    return this.sendMarkdown(lines.join('\n'), options);
  }

  /**
   * 获取某 actor comm_handle 对应的平台 user ID（用于 @mention）
   * 平台不支持时返回 null
   * @param {string} handle
   * @returns {Promise<string|null>}
   */
  async resolveHandle(handle) { return null; }
}
