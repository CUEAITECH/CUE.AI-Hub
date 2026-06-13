// server/logger.js
// 全局结构化日志（pino），替代所有 console.log/warn/error
// Part B + Part I 决策 20
//
// 使用方法：
//   import logger from '../logger.js';
//   logger.info('[module] 消息');
//   logger.warn('[module] 警告');
//   logger.error({ err }, '[module] 错误');
//
// 子 logger（带 module 标签）：
//   const log = logger.child({ module: 'autonomy' });
//   log.info('Circuit Breaker 触发');

import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test';
const isDev = process.env.NODE_ENV !== 'production' && !isTest;
// pino-pretty 走 worker thread，在部分环境（Node 24 / macOS）下 worker 启动会
// 挂起数十秒甚至卡死，导致服务 boot 在第一行日志前就卡住。默认直接写 stdout
// （与生产一致、同步、无 worker）；需要彩色美化时显式 LOG_PRETTY=1 开启。
const usePretty = isDev && process.env.LOG_PRETTY === '1';

const noop = () => {};
const noopLogger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => noopLogger };

const logger = isTest
  ? noopLogger
  : pino(
      {
        level: process.env.LOG_LEVEL || 'info',
        timestamp: pino.stdTimeFunctions.isoTime,
        base: {
          pid: process.pid,
          env: process.env.NODE_ENV || 'development',
        },
        serializers: {
          err: pino.stdSerializers.err,
          error: pino.stdSerializers.err,
        },
      },
      usePretty
        ? pino.transport({
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss',
              ignore: 'pid,hostname,env',
              messageFormat: '{msg}',
            },
          })
        : process.stdout
    );

export default logger;

/**
 * 创建带 module 标签的子 logger
 * @param {string} module - 模块名称，如 'autonomy', 'weeklyLearning'
 */
export function childLogger(module) {
  return logger.child({ module });
}
