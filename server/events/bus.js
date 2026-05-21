// server/events/bus.js
// in-process EventEmitter + outbox 落库
// 保证：emit 之前先落库，落库失败则 emit 也不发生（原子性）

import { EventEmitter } from 'node:events';
import { validateEvent } from './types.js';
import { dbWrite } from '../db/actor.js';
import { getDb } from '../db/index.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/**
 * 发布事件
 * 1. 校验 payload（zod）
 * 2. 写入 events 表（幂等键去重）
 * 3. 触发内存订阅者
 *
 * @param {string} type
 * @param {object} payload
 * @param {object} [meta]
 * @param {string} [meta.source]     - 'webhook'/'wecom'/'scheduler'/'ui'/'agent'
 * @param {string} [meta.eventId]    - 幂等键（GitHub delivery id 等）
 */
export async function emit(type, payload, meta = {}) {
  const validated = validateEvent(type, payload);
  const tenantId = validated.tenantId || 'default';

  // 落 outbox（串行写）
  const eventId = meta.eventId || `${type}:${tenantId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  await dbWrite(`emit:${type}`, (db) => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO events (tenant_id, type, payload_json, source, event_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(tenantId, type, JSON.stringify(validated), meta.source || null, eventId);
  });

  // 触发内存订阅者（fire and forget，失败不影响落库）
  try {
    emitter.emit(type, validated);
    emitter.emit('*', type, validated);  // 通配符订阅
  } catch (err) {
    console.error(`[EventBus] subscriber error for ${type}:`, err.message);
  }
}

/**
 * 订阅事件
 * @param {string|string[]} types
 * @param {function} handler - async (payload) => void
 */
export function on(types, handler) {
  const typeList = Array.isArray(types) ? types : [types];
  for (const t of typeList) {
    emitter.on(t, async (payload) => {
      try {
        await handler(payload);
      } catch (err) {
        console.error(`[EventBus] handler error for ${t}:`, err.message);
      }
    });
  }
}

/**
 * 标记事件已处理
 */
export async function markProcessed(eventRowId) {
  await dbWrite('mark-processed', (db) => {
    db.prepare('UPDATE events SET processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(eventRowId);
  });
}

/**
 * 重放未处理事件（服务重启后调用）
 */
export async function replayUnprocessed() {
  const db = getDb();
  const pending = db.prepare(`
    SELECT * FROM events WHERE processed_at IS NULL ORDER BY id ASC LIMIT 100
  `).all();

  console.log(`[EventBus] replaying ${pending.length} unprocessed events`);
  for (const row of pending) {
    try {
      const payload = JSON.parse(row.payload_json);
      emitter.emit(row.type, payload);
      emitter.emit('*', row.type, payload);
      db.prepare('UPDATE events SET processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    } catch (err) {
      console.error(`[EventBus] replay failed for event ${row.id}:`, err.message);
    }
  }
}

export { emitter };
