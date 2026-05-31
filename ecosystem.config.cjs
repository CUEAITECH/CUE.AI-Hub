// PM2 进程配置
// 生产：pm2 start ecosystem.config.cjs --only cue-hub-prod
// 测试：pm2 start ecosystem.config.cjs --only cue-hub-dev
// 全部：pm2 start ecosystem.config.cjs

module.exports = {
  apps: [
    // ── 生产环境（main 分支）────────────────────────────────────────
    {
      name: 'cue-hub-prod',
      script: 'server/index.js',
      interpreter: 'node',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 4317,
        // 其余 secrets 从服务器 .env 或系统环境变量读取
      },
    },

    // ── 测试环境（staging 分支）─────────────────────────────────────
    {
      name: 'cue-hub-dev',
      // 注意：服务器上需要把 staging 分支 clone 到这个路径
      // 例如：git clone -b staging <repo> /opt/cue-hub-dev
      cwd: '/opt/cue-hub-dev',
      script: 'server/index.js',
      interpreter: 'node',
      watch: false,
      env: {
        NODE_ENV: 'development',
        PORT: 4318,
        // 测试环境用独立数据文件，避免污染生产数据
        DB_PATH: '/opt/cue-hub-dev/server/data/db.json',
      },
    },
  ],
};
