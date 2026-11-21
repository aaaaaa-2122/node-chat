#!/usr/bin/env bash
#
# 在本地把网页端推到云服务器并安装
#
#   ./deploy/push.sh <公网IP> [ssh用户] [ssh端口] [私钥路径] [远端端口] [上游端口]
#
# 例：
#   ./deploy/push.sh 203.0.113.10 ubuntu 22 ~/.ssh/id_ed25519
#   ./deploy/push.sh 203.0.113.10 ubuntu 22 ~/.ssh/id_rsa.pem 8080 9099
#
set -euo pipefail

HOST="${1:-}"
SSH_USER="${2:-root}"
SSH_PORT="${3:-22}"
KEY="${4:-}"
WEB_PORT="${5:-80}"
UPSTREAM_PORT="${6:-9099}"
REMOTE_DIR="/tmp/node-chat-web-deploy"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

[ -n "$HOST" ] || { echo "用法: ./deploy/push.sh <公网IP> [ssh用户] [ssh端口] [私钥路径] [远端端口] [上游端口]"; exit 1; }

# 私钥要转成绝对路径：下面会 cd 到别处，相对路径会失效
if [ -n "$KEY" ]; then
  KEY="$(cd "$(dirname "$KEY")" 2>/dev/null && pwd)/$(basename "$KEY")"
  [ -f "$KEY" ] || { echo "❌ 私钥不存在：$KEY"; exit 1; }
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=12 -o ServerAliveInterval=30)
SCP_OPTS=(-P "$SSH_PORT" "${SSH_OPTS[@]}")
SSH_OPTS+=(-p "$SSH_PORT")
if [ -n "$KEY" ]; then
  SSH_OPTS+=(-i "$KEY")
  SCP_OPTS+=(-i "$KEY")
fi

echo "==> 打包"
cd "$HERE"
rm -f ./deploy.tgz
# 统一 LF：CRLF 会让远端 bash 报 "pipefail: invalid option name"
sed -i 's/\r$//' deploy/install-web.sh deploy/push.sh deploy/enable-https.sh 2>/dev/null || true

rm -rf ./.pack && mkdir -p ./.pack/app
cp -a src ./.pack/app/src
cp -a public ./.pack/app/public
cp -a README.md ./.pack/app/README.md
cp -a package.json ./.pack/app/package.json 2>/dev/null || true
cp -a deploy/install-web.sh ./.pack/install-web.sh
cp -a deploy/enable-https.sh ./.pack/enable-https.sh
tar czf ./deploy.tgz -C ./.pack app install-web.sh enable-https.sh
rm -rf ./.pack
echo "    $(du -h ./deploy.tgz | cut -f1)  deploy.tgz"

echo "==> 上传到 $SSH_USER@$HOST:$REMOTE_DIR"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
scp "${SCP_OPTS[@]}" ./deploy.tgz "$SSH_USER@$HOST:$REMOTE_DIR/"
rm -f ./deploy.tgz

echo "==> 远端安装（端口 $WEB_PORT，上游 127.0.0.1:$UPSTREAM_PORT）"
# shellcheck disable=SC2029
ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" \
  "cd $REMOTE_DIR && tar xzf deploy.tgz && sudo bash install-web.sh $WEB_PORT $UPSTREAM_PORT"

echo
echo "==> 完成：http://$HOST:$WEB_PORT/"
