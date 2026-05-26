/**
 * syncTrace.js
 * 调试用：追踪 syncProjectPRs / buildHubReview 的调用来源和频率
 * 写入 server/data/sync-trace.log（append-only），GET /api/debug/sync-trace 读取
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../logger.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '..', 'data', 'sync-trace.log');
const MAX_BYTES = 5 * 1024 * 1024; // 5MB 自动滚动

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    }
  } catch {
    // 文件不存在，忽略
  }
}

/**
 * 记录一次 trace 事件
 * @param {string} event - 事件类型（sync-start / sync-end / llm-call / llm-skip / pr-agent-sink）
 * @param {object} payload - 附加信息
 */
export function trace(event, payload = {}) {
  try {
    rotateIfNeeded();
    const line = JSON.stringify({
      t: new Date().toISOString(),
      event,
      ...payload,
      // 抓调用栈（去掉前 2 行：Error + trace 自身）
      stack: new Error().stack.split('\n').slice(2, 6).map((s) => s.trim())
    }) + '\n';
    fs.appendFileSync(LOG_PATH, line);
  } catch (err) {
    logger.error('[syncTrace] failed:', err.message);
  }
}

/**
 * 读取最近 N 行 trace
 */
export function readTrace(lines = 200) {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    const all = content.trim().split('\n').filter(Boolean);
    return all.slice(-lines).map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  } catch (err) {
    return [{ error: err.message }];
  }
}

/**
 * 统计窗口内的调用频次（按事件聚合）
 */
export function summarizeTrace(lines = 1000) {
  const entries = readTrace(lines);
  const byEvent = {};
  const byMinute = {};
  for (const e of entries) {
    byEvent[e.event] = (byEvent[e.event] || 0) + 1;
    const minute = (e.t || '').slice(0, 16); // YYYY-MM-DDTHH:MM
    byMinute[minute] = (byMinute[minute] || 0) + 1;
  }
  return {
    totalEntries: entries.length,
    byEvent,
    peakMinutes: Object.entries(byMinute)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([minute, count]) => ({ minute, count })),
    firstAt: entries[0]?.t,
    lastAt: entries[entries.length - 1]?.t
  };
}
