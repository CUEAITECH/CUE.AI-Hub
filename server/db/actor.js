// server/db/actor.js
// 所有写入 SQLite 的操作都通过这个队列串行化
// 解决：并发 webhook 下的 lost-update（postmortem M4）

import PQueue from 'p-queue';
import { getDb } from './index.js';
import logger from '../logger.js';


const writeQueue = new PQueue({ concurrency: 1 });

let _pendingWrites = 0;
let _totalWrites = 0;

/**
 * 串行执行一个写操作（事务）
 * @param {string} label - 用于 debug 的标签
 * @param {function} fn - 同步函数，接收 better-sqlite3 db 实例
 * @returns {Promise<any>} fn 的返回值
 */
export async function dbWrite(label, fn) {
  _pendingWrites++;
  return writeQueue.add(() => {
    const db = getDb();
    _pendingWrites--;
    _totalWrites++;
    try {
      return db.transaction(fn)(db);
    } catch (err) {
      logger.error(`[actor] write failed (${label}):`, err.message);
      throw err;
    }
  }, { priority: 0 });
}

/**
 * 高优先级写（如 P1 事件处理）
 */
export async function dbWriteUrgent(label, fn) {
  _pendingWrites++;
  return writeQueue.add(() => {
    const db = getDb();
    _pendingWrites--;
    _totalWrites++;
    return db.transaction(fn)(db);
  }, { priority: 10 });
}

export function getWriteStats() {
  return {
    pending: _pendingWrites,
    total: _totalWrites,
    queueSize: writeQueue.size
  };
}
