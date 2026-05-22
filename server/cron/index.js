// server/cron/index.js
// 替代 scheduler.js 的 setInterval 时钟
// cron 表达式清晰，不再手写 hour/minute 判断

import cron from 'node-cron';
import { emit } from '../events/bus.js';
import logger from '../logger.js';

const TENANT = process.env.DEFAULT_TENANT_ID || 'default';

// ══════════════════════════════════════════════════════════════
// O.3 监控告警阈值（Part O.3）
// ══════════════════════════════════════════════════════════════
const MONITOR_CONFIG = {
  unprocessedEventsThreshold: 50,  // events 表未处理数 > 50 → P1
  llmFailRateThreshold: 0.10,      // llm_calls 失败率 > 10%/5min → P1
  llmDailyCostYuan: 50,            // 当日成本 > ¥50 → P2（按 token 估算）
  webhookP99Ms: 30_000,            // webhook 处理 p99 > 30s → P2
  // 成本估算参数（Sonnet 4.5 定价，近似值）
  costPerInputToken:  0.000003,    // $3/M input tokens
  costPerOutputToken: 0.000015,    // $15/M output tokens
  usdToYuan: 7.2,
};

/**
 * 每 5 分钟运行一次的监控检查
 * 从 events/llm_calls 表实时查询，不引入 Prometheus
 */
async function runMonitorCheck() {
  try {
    const { getDb } = await import('../db/index.js');
    const { broadcast } = await import('../adapters/index.js');
    const db = getDb();

    // 1. 未处理事件堆积
    const { unprocessed } = db.prepare(
      "SELECT COUNT(*) as unprocessed FROM events WHERE processed_at IS NULL"
    ).get();
    if (unprocessed > MONITOR_CONFIG.unprocessedEventsThreshold) {
      logger.warn(`[monitor] events 堆积 ${unprocessed} 条 (阈值 ${MONITOR_CONFIG.unprocessedEventsThreshold})`);
      await broadcast(
        `🚨 **P1 告警：事件队列堆积**\n\nevents 表未处理事件 **${unprocessed}** 条（阈值 ${MONITOR_CONFIG.unprocessedEventsThreshold}）\n\n排查：查看 events 表 WHERE processed_at IS NULL`,
        { urgency: 'high' }
      );
    }

    // 2. LLM 调用失败率（近 5 分钟）
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const llmStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN output_tokens IS NULL OR output_tokens = 0 THEN 1 ELSE 0 END) as failed
      FROM llm_calls
      WHERE ts >= ?
    `).get(fiveMinAgo);

    if (llmStats.total >= 3) { // 至少 3 次调用才计算失败率
      const failRate = llmStats.failed / llmStats.total;
      if (failRate > MONITOR_CONFIG.llmFailRateThreshold) {
        const pct = Math.round(failRate * 100);
        logger.warn(`[monitor] LLM 失败率 ${pct}% (近5分钟 ${llmStats.total} 次调用)`);
        await broadcast(
          `🚨 **P1 告警：LLM 调用失败率过高**\n\n近 5 分钟失败率 **${pct}%**（阈值 10%）\n共 ${llmStats.total} 次调用，${llmStats.failed} 次失败\n\n排查：查看 llm_calls 表 WHERE ts >= '${fiveMinAgo}'`,
          { urgency: 'high' }
        );
      }
    }

    // 3. 当日 LLM 成本超限（按 token 估算）
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const costStats = db.prepare(`
      SELECT
        SUM(input_tokens)  as totalInput,
        SUM(output_tokens) as totalOutput,
        COUNT(*) as totalCalls
      FROM llm_calls
      WHERE ts >= ?
    `).get(todayStart.toISOString());

    if (costStats.totalInput || costStats.totalOutput) {
      const costUsd = (costStats.totalInput  || 0) * MONITOR_CONFIG.costPerInputToken
                    + (costStats.totalOutput || 0) * MONITOR_CONFIG.costPerOutputToken;
      const costYuan = costUsd * MONITOR_CONFIG.usdToYuan;
      if (costYuan > MONITOR_CONFIG.llmDailyCostYuan) {
        logger.warn(`[monitor] 今日 LLM 成本 ¥${costYuan.toFixed(2)} 超限`);
        await broadcast(
          `⚠️ **P2 告警：今日 LLM 成本超限**\n\n今日已消耗约 **¥${costYuan.toFixed(2)}**（阈值 ¥${MONITOR_CONFIG.llmDailyCostYuan}）\n共 ${costStats.totalCalls} 次调用\n\n排查：查看 llm_calls 表按 purpose 分组`,
          { urgency: 'medium' }
        );
      }
    }

  } catch (err) {
    // 监控本身不能阻断服务
    logger.error({ err }, '[monitor] 监控检查异常（非致命）');
  }
}

export function startCron({ meetingHour = 18, isCompanyWorkday, todayText, githubSyncIntervalMinutes = 10 }) {
  const prepHour = meetingHour === 0 ? 23 : meetingHour - 1;

  // ── 17:45 晚会作战包（工作日）─────────────────────────────
  // cron: 45 分钟、prepHour 点、周一二四五日（公司工作日，非周三非周六）
  cron.schedule(`45 ${prepHour} * * 0,1,2,4,5`, async () => {
    const today = todayText();
    if (!isCompanyWorkday(today)) return;
    logger.info(`[cron] evening.report.due: ${today}`);
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
      emit('doc.scan.requested', { tenantId: TENANT }, { source: 'scheduler' }).catch(err => logger.error({ err }, '[cron] doc.scan.requested failed'));
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
      if (!err) logger.info('[cron] daily db.json snapshot done');
      else logger.error('[cron] snapshot failed:', err.message);
    });
  }, { timezone: 'Asia/Shanghai' });

  // ── 每日 02:00 — Outcome Backfill（7 天观察期到期的 PR）──
  // Part M.1：pr.merged 后 7 天回查 revert/fix commit，更新 polarity
  cron.schedule('0 2 * * *', async () => {
    const { runOutcomeBackfill } = await import('../services/outcomeBackfill.js');
    const result = await runOutcomeBackfill({ tenantId: TENANT }).catch(err => {
      logger.error({ err }, '[cron] outcomeBackfill failed');
      return { checked: 0, updated: 0 };
    });
    logger.info(`[cron] outcomeBackfill done: checked=${result.checked} updated=${result.updated}`);
  }, { timezone: 'Asia/Shanghai' });

  // ── O.3 监控告警（每 5 分钟）──────────────────────────────
  cron.schedule('*/5 * * * *', runMonitorCheck);
  // 启动后 30 秒跑第一次（尽早发现问题）
  setTimeout(runMonitorCheck, 30_000);

  logger.info('[cron] ✅ scheduled (meetingHour:', meetingHour, '+ O.3 monitor every 5min)');
}
