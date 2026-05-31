#!/usr/bin/env bash
# deploy/deploy-dev.sh
# 在服务器上执行：把 staging 分支最新代码拉下来并重启 dev 进程
# 用法：bash deploy/deploy-dev.sh
# 或通过 SSH 远程执行：ssh user@server 'cd /opt/cue-hub-dev && bash deploy/deploy-dev.sh'

set -euo pipefail

DEV_DIR="${DEV_DIR:-/opt/cue-hub-dev}"
BRANCH="${BRANCH:-staging}"

echo "==> 拉取 $BRANCH 最新代码..."
cd "$DEV_DIR"
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo "==> 安装依赖..."
npm install --omit=dev

echo "==> 重启 PM2 进程..."
pm2 restart cue-hub-dev --update-env

echo "==> 完成 ✓ (dev.hub.cueai.top)"
pm2 show cue-hub-dev | grep -E "status|uptime|port" || true
