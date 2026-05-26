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

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    // 生产环境输出 JSON，开发环境 pino-pretty 美化
    ...(isDev ? {} : {}),
    // 时间戳格式
    timestamp: pino.stdTimeFunctions.isoTime,
    // 基础字段
    base: {
      pid: process.pid,
      env: process.env.NODE_ENV || 'development',
    },
    // 将 err 对象序列化为可读格式
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  },
  isDev
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
