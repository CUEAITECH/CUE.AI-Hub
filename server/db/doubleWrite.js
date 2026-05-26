// server/db/doubleWrite.js
// 在 v2.db 写入的同时，保持 db.json 同步
// 7 天后确认一致性，运行 cutover.js 删除此层

import { loadStore, saveStore } from '../store.js';
import logger from '../logger.js';


let _enabled = process.env.DOUBLE_WRITE !== 'false';

export function isDoubleWriteEnabled() { return _enabled; }
export function disableDoubleWrite() { _enabled = false; }

/**
 * 在 SQLite 写入后，同步更新 db.json 对应字段
 * 调用方：reducer.js 每次 mutation 后
 */
export async function syncToJsonStore(table, id, data) {
  if (!_enabled) return;
  try {
    const store = await loadStore();
    const collectionMap = {
      tasks: 'tasks',
      actors: null,     // actors 在 db.json 里没有对应集合
      pulls: 'pulls',
      reviews: 'reviews',
      activities: 'activities',
      assignments: 'assignments',
      standups: 'standups',
    };
    const collection = collectionMap[table];
    if (!collection || !store[collection]) return;

    const idx = store[collection].findIndex(r => r.id === id);
    if (idx === -1) store[collection].unshift(data);
    else store[collection][idx] = data;

    await saveStore(store);
  } catch (err) {
    // 双写失败不应阻断主流程
    logger.error('[doubleWrite] sync failed:', err.message);
  }
}
