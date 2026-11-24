#!/usr/bin/env bash
#
# 在本地（Windows Git Bash / macOS / Linux）把服务端推到云服务器并安装
#
#   ./push.sh <公网IP> [ssh用户] [ssh端口] [私钥路径]
#
# 例：
#   ./push.sh 198.51.100.20                      # 默认 root / 22 / 默认密钥
#   ./push.sh 198.51.100.20 <SSH_USER> 22 ~/.ssh/id_rsa.pem
#
# 说明：
#   - 走 SSH 密钥登录（密码登录需要交互输入，脚本里不做）
#   - 服务器上以 root 安装（非 root 用户会自动加 sudo）
#
set -euo pipefail

HOST="${1:-}"
SSH_USER="${2:-root}"
SSH_PORT="${3:-22}"
KEY="${4:-}"
REMOTE_DIR="/tmp/node-chat-deploy"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -n "$HOST" ] || { echo "用法: ./push.sh <公网IP> [ssh用户] [ssh端口] [私钥路径]"; exit 1; }

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=12 -o ServerAliveInterval=30)
SCP_OPTS=(-P "$SSH_PORT" "${SSH_OPTS[@]}")
SSH_OPTS+=(-p "$SSH_PORT")
if [ -n "$KEY" ]; then
  SSH_OPTS+=(-i "$KEY")
  SCP_OPTS+=(-i "$KEY")
fi

echo "==> 打包"
# 注意：Git Bash 下 mktemp 返回 C:/... 形式，tar/scp 会把它当成「主机:路径」，所以用相对路径
cd "$HERE"
rm -f ./deploy.tgz
# 统一 LF，CRLF 会让远端 bash 报 "pipefail: invalid option name"
sed -i 's/\r$//' install.sh push.sh 2>/dev/null || true

# 服务端代码：独立部署包用 ./app，源码包里代码在 ../server（tar 里仍要叫 app/）
if [ -f "$HERE/app/src/server.js" ]; then
  APP_SRC="$HERE/app"
elif [ -f "$HERE/../server/src/server.js" ]; then
  APP_SRC="$HERE/../server"
else
  echo "❌ 找不到服务端代码（app/src/server.js）" >&2
  exit 1
fi
rm -rf ./.pack && mkdir -p ./.pack/app
cp -r "$APP_SRC"/. ./.pack/app/

tar czf ./deploy.tgz -C ./.pack app -C "$HERE" install.sh
rm -rf ./.pack
echo "    $(du -h ./deploy.tgz | cut -f1)  deploy.tgz"

echo "==> 上传到 $SSH_USER@$HOST:$SSH_PORT"
scp "${SCP_OPTS[@]}" ./deploy.tgz "$SSH_USER@$HOST:/tmp/node-chat-deploy.tgz"

echo "==> 远端解压并安装"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "
  set -e
  rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR
  tar xzf /tmp/node-chat-deploy.tgz -C $REMOTE_DIR
  cd $REMOTE_DIR
  if [ \"\$(id -u)\" = 0 ]; then bash install.sh; else sudo bash install.sh; fi
"

rm -f ./deploy.tgz
echo "==> 完成"
