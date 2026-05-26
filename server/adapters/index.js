// server/adapters/index.js
// 通信平台适配器注册中心
// 按环境变量自动选择可用的适配器
// 愿景：Hub 工作在通信平台之上，不依赖任何一个

import { WeComAdapter } from './wecom.js';
import { SlackAdapter } from './slack.js';
import { FeishuAdapter } from './feishu.js';
import { NotificationAdapter } from './base.js';
import logger from '../logger.js';


/** 已注册的适配器实例（按优先级排列） */
const _adapters = [];

/** 初始化：扫描环境变量，注册可用适配器 */
export function initAdapters() {
  _adapters.length = 0;

  const wecom = new WeComAdapter();
  if (wecom.isAvailable()) {
    _adapters.push(wecom);
    logger.info('[adapters] ✅ WeComAdapter active');
  }

  const slack = new SlackAdapter();
  if (slack.isAvailable()) {
    _adapters.push(slack);
    logger.info('[adapters] ✅ SlackAdapter active');
  }

  const feishu = new FeishuAdapter();
  if (feishu.isAvailable()) {
    _adapters.push(feishu);
    logger.info('[adapters] ✅ FeishuAdapter active');
  }

  if (_adapters.length === 0) {
    logger.info('[adapters] ⚪ no notification adapters configured (set WECOM_WEBHOOK_URL/SLACK_WEBHOOK_URL/FEISHU_WEBHOOK_URL)');
  }

  return _adapters;
}

/**
 * 获取第一个可用适配器（主推送通道）
 * @returns {NotificationAdapter|null}
 */
export function getPrimaryAdapter() {
  return _adapters[0] || null;
}

/**
 * 获取所有可用适配器（广播模式）
 * @returns {NotificationAdapter[]}
 */
export function getAllAdapters() {
  return [..._adapters];
}

/**
 * 广播：向所有可用平台发送消息
 * 任意一个成功则视为成功
 * @param {string} markdown
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
export async function broadcast(markdown, options = {}) {
  if (_adapters.length === 0) return false;
  const results = await Promise.allSettled(
    _adapters.map(a => a.sendMarkdown(markdown, options))
  );
  return results.some(r => r.status === 'fulfilled' && r.value === true);
}

/**
 * 发送结构化通知（卡片）到所有可用平台
 * @param {object} card
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
export async function broadcastCard(card, options = {}) {
  if (_adapters.length === 0) return false;
  const results = await Promise.allSettled(
    _adapters.map(a => a.sendCard(card, options))
  );
  return results.some(r => r.status === 'fulfilled' && r.value === true);
}

/**
 * 手动注册自定义适配器（测试或第三方插件用）
 * @param {NotificationAdapter} adapter
 */
export function registerAdapter(adapter) {
  if (!(adapter instanceof NotificationAdapter)) {
    throw new Error('adapter must extend NotificationAdapter');
  }
  _adapters.push(adapter);
}
