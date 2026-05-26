// server/events/eveningReportHandler.js
// Part K 闭环：evening.report.due → 触发晚会作战包生成
//
// 这是将 scheduler.js setInterval 晚会流程迁移到 v2 EventBus 的第一步：
//   cron 17:45 → emit('evening.report.due') → 此 handler 生成作战包
//
// 当前状态：
//   scheduler.js 仍保留（驱动 v1 store 的晚会流程），避免双重触发，
//   此 handler 在 ENABLE_V2_EVENING=true 时生效，默认 false（迁移进行中）
//
// 完全迁移条件：
//   1. v2 tasks 表与 v1 store.tasks 完全对齐（双写期结束）
//   2. generateEveningReport 改为从 SQLite 读数据（而非 store.js）
//   3. 删除 scheduler.js 中的作战包触发逻辑

import { on } from './bus.js';
import logger from '../logger.js';

const ENABLED = process.env.ENABLE_V2_EVENING === 'true';

if (ENABLED) {
  on('evening.report.due', async ({ tenantId, date }) => {
    logger.info(`[eveningReportHandler] evening.report.due received: date=${date} tenant=${tenantId}`);

    try {
      // 动态 import 避免循环依赖（dailyBrief.js 仍依赖 v1 store）
      const { generateEveningReport } = await import('../services/dailyBrief.js');
      await generateEveningReport(date);
      logger.info(`[eveningReportHandler] evening report generated for ${date}`);

      // 发射完成事件
      const { emit } = await import('./bus.js');
      await emit('evening.report.generated',
        { tenantId, date, reportId: `evening_${date}` },
        { source: 'evening-handler', eventId: `evening.generated:${date}` }
      );
    } catch (err) {
      logger.error({ err }, `[eveningReportHandler] failed to generate evening report for ${date}`);
    }
  });

  logger.info('[eveningReportHandler] ✅ registered (ENABLE_V2_EVENING=true)');
} else {
  logger.info('[eveningReportHandler] ⏸ skipped (set ENABLE_V2_EVENING=true to enable v2 evening flow)');
}
