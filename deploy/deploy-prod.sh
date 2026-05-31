#!/usr/bin/env bash
# deploy/deploy-prod.sh
# 生产部署：拉取 main 最新代码并重启 prod 进程
# 用法：bash deploy/deploy-prod.sh

set -euo pipefail

PROD_DIR="${PROD_DIR:-/opt/cue-hub}"
BRANCH="${BRANCH:-main}"

echo "==> 拉取 $BRANCH 最新代码..."
cd "$PROD_DIR"
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo "==> 安装依赖..."
npm install --omit=dev

echo "==> 重启 PM2 进程..."
pm2 restart cue-hub-prod --update-env

echo "==> 完成 ✓ (hub.cueai.top)"
pm2 show cue-hub-prod | grep -E "status|uptime|port" || true
