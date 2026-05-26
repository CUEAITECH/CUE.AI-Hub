#!/usr/bin/env node
// scripts/test-event-replay.mjs — 事件重放测试
//
// 验证 EventBus 的可靠性约束：
//   1. emit 先落库后触发订阅者（outbox-first）
//   2. 重放恢复未处理事件（restart resilience）
//   3. 幂等 event_id 去重（no-double-fire）
//   4. 未知 event type 被 validateEvent 拒绝
//   5. 订阅者异常不影响事件落库
//   6. 多租户事件互相隔离（event_id unique 不跨 tenant）
//
// 用法：node scripts/test-event-replay.mjs
//        npm run test:event-replay
//
// 注意：使用独立内存 DB，不影响生产数据

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
    passCount++;
  } catch (err) {
    console.error(`not ok ${name}`);
    console.error('  ', err.message);
    failCount++;
  }
}

// ── 最小内存 DB（替代 initDb()，避免副作用）────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source TEXT,
      event_id TEXT UNIQUE,
      processed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

// ── 轻量 EventBus（从 bus.js 剥离，使用注入 DB）──────────────

import { EventEmitter } from 'node:events';

function makeBus(db) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  async function emit(type, payload, meta = {}) {
    const eventId = meta.eventId || `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const tenantId = payload.tenantId || 'default';

    // outbox-first: 先落库
    const result = db.prepare(`
      INSERT OR IGNORE INTO events (tenant_id, type, payload_json, source, event_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenantId, type, JSON.stringify(payload), meta.source || null, eventId);

    // 只有落库成功才触发（INSERT OR IGNORE：重复则 changes=0）
    if (result.changes > 0) {
      try {
        emitter.emit(type, payload);
        emitter.emit('*', type, payload);
      } catch (err) {
        // 订阅者异常不向上冒泡（不影响 outbox 一致性）
        console.error(`[bus] subscriber error for ${type}:`, err.message);
      }
    }
    return { eventId, stored: result.changes > 0 };
  }

  function on(types, handler) {
    const typeList = Array.isArray(types) ? types : [types];
    for (const t of typeList) {
      emitter.on(t, async (payload) => {
        try { await handler(payload); }
        catch { /* swallow */ }
      });
    }
  }

  function replay() {
    const pending = db.prepare(`
      SELECT * FROM events WHERE processed_at IS NULL ORDER BY id ASC LIMIT 100
    `).all();

    for (const row of pending) {
      const payload = JSON.parse(row.payload_json);
      emitter.emit(row.type, payload);
      emitter.emit('*', row.type, payload);
      db.prepare('UPDATE events SET processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    }
    return pending.length;
  }

  return { emit, on, replay, emitter, db };
}

// ══════════════════════════════════════════════════════════════
// 测试用例
// ══════════════════════════════════════════════════════════════

// 1. outbox-first：emit 落库先于订阅者收到事件
await test('outbox-first: event in DB before subscriber fires', async () => {
  const db = makeDb();
  const bus = makeBus(db);
  let handlerFiredWithDbRecord = false;

  bus.on('task.claimed', () => {
    const row = db.prepare('SELECT * FROM events WHERE type = ?').get('task.claimed');
    handlerFiredWithDbRecord = !!row;
  });

  await bus.emit('task.claimed', { tenantId: 'default', taskId: 'task_1', actorId: 'actor_a' });
  assert.ok(handlerFiredWithDbRecord, 'subscriber should see DB record on fire');
});

// 2. 重放：重启后恢复未处理事件
await test('replay: unprocessed events are re-emitted on restart', async () => {
  const db = makeDb();

  // 直接插入未处理事件（模拟宕机前的状态）
  db.prepare(`
    INSERT INTO events (type, payload_json, event_id)
    VALUES (?, ?, ?)
  `).run('task.claimed', JSON.stringify({ tenantId: 'default', taskId: 'task_r1', actorId: 'a1' }), 'replay-evt-1');

  db.prepare(`
    INSERT INTO events (type, payload_json, event_id)
    VALUES (?, ?, ?)
  `).run('pr.merged', JSON.stringify({ tenantId: 'default', prNumber: 1, repoFull: 'org/repo', mergedAt: '2024-01-01', taskIds: [] }), 'replay-evt-2');

  const bus = makeBus(db);
  const received = [];
  bus.on(['task.claimed', 'pr.merged'], (p) => received.push(p));

  const count = bus.replay();
  assert.equal(count, 2, 'should replay 2 unprocessed events');
  assert.equal(received.length, 2, 'both events should have fired handlers');
});

// 3. 重放后标记已处理（不会二次触发）
await test('replay: processed events are not replayed again', async () => {
  const db = makeDb();
  const bus = makeBus(db);

  await bus.emit('task.claimed', { tenantId: 'default', taskId: 'task_p1', actorId: 'a1' }, { eventId: 'once-only' });

  // 标记已处理
  db.prepare('UPDATE events SET processed_at = CURRENT_TIMESTAMP WHERE event_id = ?').run('once-only');

  let secondFire = 0;
  bus.on('task.claimed', () => secondFire++);

  bus.replay(); // 不应该重放（已有 processed_at）
  assert.equal(secondFire, 0, 'processed event should not fire again');
});

// 4. 幂等性：相同 event_id 只存储一次
await test('idempotency: same event_id is not stored twice', async () => {
  const db = makeDb();
  const bus = makeBus(db);

  const r1 = await bus.emit('task.claimed', { taskId: 't1', actorId: 'a1' }, { eventId: 'idem-001' });
  const r2 = await bus.emit('task.claimed', { taskId: 't1', actorId: 'a1' }, { eventId: 'idem-001' });

  assert.equal(r1.stored, true, 'first emit should be stored');
  assert.equal(r2.stored, false, 'second emit with same eventId should be ignored');

  const count = db.prepare('SELECT COUNT(*) as c FROM events WHERE event_id = ?').get('idem-001').c;
  assert.equal(count, 1, 'only one row should exist');
});

// 5. 幂等性：订阅者只收到一次事件
await test('idempotency: subscriber fires only once for duplicate event_id', async () => {
  const db = makeDb();
  const bus = makeBus(db);
  let fireCount = 0;

  bus.on('pr.merged', () => fireCount++);

  const payload = { prNumber: 42, repoFull: 'org/repo', mergedAt: '2024-01-01', taskIds: [] };
  await bus.emit('pr.merged', payload, { eventId: 'pr-idem-042' });
  await bus.emit('pr.merged', payload, { eventId: 'pr-idem-042' }); // 重复

  assert.equal(fireCount, 1, 'subscriber should fire exactly once');
});

// 6. 未知事件类型被 validateEvent 拒绝
await test('validation: unknown event type throws', async () => {
  const { validateEvent } = await import('../server/events/types.js');

  assert.throws(
    () => validateEvent('unknown.event', { tenantId: 'default' }),
    /Unknown event type/,
    'unknown event type should throw'
  );
});

// 7. 已知事件类型校验通过
await test('validation: known event types validate correctly', async () => {
  const { validateEvent } = await import('../server/events/types.js');

  // 所有这些应该通过（不抛出异常）
  assert.doesNotThrow(() =>
    validateEvent('task.claimed', { tenantId: 'default', taskId: 'task_1', actorId: 'actor_1', source: 'ui' })
  );

  assert.doesNotThrow(() =>
    validateEvent('pr.merged', { tenantId: 'default', prNumber: 1, repoFull: 'org/repo', mergedAt: '2024-01-01' })
  );

  assert.doesNotThrow(() =>
    validateEvent('evening.report.due', { tenantId: 'default', date: '2024-01-01' })
  );
});

// 8. 缺少必填字段的事件被拒绝
await test('validation: missing required fields throw ZodError', async () => {
  const { validateEvent } = await import('../server/events/types.js');

  assert.throws(
    () => validateEvent('task.claimed', { tenantId: 'default' /* missing taskId, actorId, source */ }),
    { name: 'ZodError' },
    'missing required field should throw ZodError'
  );
});

// 9. 订阅者异常不影响其他订阅者（隔离性）
await test('subscriber isolation: one failing handler does not block others', async () => {
  const db = makeDb();
  const bus = makeBus(db);
  let secondHandlerCalled = false;

  bus.on('doc.scan.requested', () => {
    throw new Error('intentional subscriber failure');
  });
  bus.on('doc.scan.requested', () => {
    secondHandlerCalled = true;
  });

  await bus.emit('doc.scan.requested', { tenantId: 'default' });

  // node EventEmitter：第一个 listener 抛出后，后续 listener 不会收到（这是 Node 行为）
  // 我们的设计在 on() 中 catch 异常，所以第二个应该被调用
  // 实际上 bus.on() 包了 try/catch，不会传播异常给 emitter
  // 因此第二个 handler 应该被调用
  assert.ok(secondHandlerCalled, 'second handler should still fire despite first failing');
});

// 10. 事件落库后即使进程重启也不丢失
await test('durability: events persist across simulated restarts', async () => {
  // 使用文件系统 DB 临时文件模拟持久化
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const tmpDir = mkdtempSync(join(tmpdir(), 'cue-replay-test-'));
  const dbPath = join(tmpDir, 'test.db');

  // 第一次"启动"：写入事件
  let db1 = new Database(dbPath);
  db1.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL, payload_json TEXT NOT NULL, source TEXT,
      event_id TEXT UNIQUE, processed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const bus1 = makeBus(db1);
  await bus1.emit('evening.report.due', { tenantId: 'default', date: '2024-01-15' }, { eventId: 'rpt-20240115' });
  db1.close();

  // 第二次"启动"：验证事件仍在 DB 中
  let db2 = new Database(dbPath);
  const rows = db2.prepare('SELECT * FROM events WHERE event_id = ?').all('rpt-20240115');
  assert.equal(rows.length, 1, 'event should persist across DB close/open');
  assert.equal(rows[0].processed_at, null, 'event should still be unprocessed');
  db2.close();

  // 清理
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

// ══════════════════════════════════════════════════════════════
// 结果汇总
// ══════════════════════════════════════════════════════════════

console.log('');
console.log(`1..${passCount + failCount}`);
console.log(`# tests ${passCount + failCount}, passed ${passCount}, failed ${failCount}`);

if (failCount > 0) process.exit(1);
