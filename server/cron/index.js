// server/cron/index.js
// 替代 scheduler.js 的 setInterval 时钟
// cron 表达式清晰，不再手写 hour/minute 判断

import cron from 'node-cron';
import { emit } from '../events/bus.js';

const TENANT = process.env.DEFAULT_TENANT_ID || 'default';

export function startCron({ meetingHour = 18, isCompanyWorkday, todayText, githubSyncIntervalMinutes = 10 }) {
  const prepHour = meetingHour === 0 ? 23 : meetingHour - 1;

  // ── 17:45 晚会作战包（工作日）─────────────────────────────
  // cron: 45 分钟、prepHour 点、周一二四五日（公司工作日，非周三非周六）
  cron.schedule(`45 ${prepHour} * * 0,1,2,4,5`, async () => {
    const today = todayText();
    if (!isCompanyWorkday(today)) return;
    console.log(`[cron] evening.report.due: ${today}`);
    await emit('evening.report.due',
      { tenantId: TENANT, date: today },
      { source: 'scheduler', eventId: `evening:${today}` }
    );
  }, { timezone: 'Asia/Shanghai' });

  // ── 18:00 会议开始（预留，现通过 event 扩展）──────────────
  cron.schedule(`0 ${meetingHour} * * 0,1,2,4,5`, async () => {
    const today = todayText();
    if (!isCompanyWorkday(today)) return;
    // 空钩：未来扩展 meeting.started event
  }, { timezone: 'Asia/Shanghai' });

  // ── GitHub 定时同步（event 驱动，减少直接 LLM 调用）───────
  if (githubSyncIntervalMinutes > 0) {
    // 首次启动 15 秒后触发
    setTimeout(() => {
      emit('doc.scan.requested', { tenantId: TENANT }, { source: 'scheduler' }).catch(console.error);
    }, 15_000);

    cron.schedule(`*/${githubSyncIntervalMinutes} * * * *`, async () => {
      await emit('doc.scan.requested',
        { tenantId: TENANT },
        { source: 'scheduler', eventId: `github-sync:${Date.now()}` }
      );
    });
  }

  // ── 每日 23:55 db.json 快照（决策 4）──────────────────────
  cron.schedule('55 23 * * *', async () => {
    const { exec } = await import('node:child_process');
    exec('cp server/data/db.json server/data/db.json.daily-snapshot', (err) => {
      if (!err) console.log('[cron] daily db.json snapshot done');
      else console.error('[cron] snapshot failed:', err.message);
    });
  }, { timezone: 'Asia/Shanghai' });

  console.log('[cron] ✅ scheduled (meetingHour:', meetingHour, ')');
}
