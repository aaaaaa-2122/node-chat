#!/usr/bin/env bash
#
# Node Chat 网页端一键安装（在云服务器上以 root 执行）
#
#   sudo bash install-web.sh [端口] [上游端口]
#
# 做的事：
#   1) 检查 Node.js（>= 18）
#   2) 代码放 /opt/node-chat-web，运行用户 nodechat（没有就建，无登录 shell）
#   3) 写 systemd 单元并启动；监听 80 用 AmbientCapabilities，不需要 root 跑进程
#   4) 放通系统防火墙（云厂商安全组仍需在控制台放通）
#
set -euo pipefail

PORT="${1:-80}"
UPSTREAM="${2:-9099}"
APP_DIR="/opt/node-chat-web"
SERVICE="/etc/systemd/system/node-chat-web.service"
HERE="$(cd "$(dirname "$0")" && pwd)"

blue() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 执行（sudo bash install-web.sh）"
[ -f "$HERE/app/src/gateway.js" ] || die "没找到 app/src/gateway.js，请在解压后的目录里执行"
[ -f "$HERE/app/public/index.html" ] || die "没找到 app/public/index.html"

blue "==> 1/5 检查 Node.js"
command -v node >/dev/null 2>&1 || die "没装 Node.js（需要 >= 18）"
NODE_BIN="$(command -v node)"
cur="$("$NODE_BIN" -p 'process.versions.node')"
major="${cur%%.*}"
[ "${major:-0}" -ge 18 ] || die "Node.js v$cur 太旧，需要 >= 18"
ok "Node.js v$cur（$NODE_BIN）"

blue "==> 2/5 准备运行用户与目录"
if id nodechat >/dev/null 2>&1; then
  ok "用户 nodechat 已存在"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin nodechat
  ok "已创建系统用户 nodechat"
fi

mkdir -p "$APP_DIR"
# 保留旧的 public 备份，便于回滚
if [ -d "$APP_DIR/public" ]; then
  rm -rf "$APP_DIR.prev"
  cp -a "$APP_DIR" "$APP_DIR.prev"
  ok "旧版本已备份到 $APP_DIR.prev"
fi
rm -rf "$APP_DIR/src" "$APP_DIR/public"
cp -a "$HERE/app/src" "$APP_DIR/src"
cp -a "$HERE/app/public" "$APP_DIR/public"
[ -f "$HERE/app/package.json" ] && cp -a "$HERE/app/package.json" "$APP_DIR/package.json"
chown -R nodechat:nodechat "$APP_DIR"
ok "代码已部署到 $APP_DIR"

blue "==> 3/5 写 systemd 单元"
cat > "$SERVICE" <<UNIT
[Unit]
Description=Node Chat Web (static + websocket gateway)
After=network.target node-chat.service
Wants=node-chat.service

[Service]
Type=simple
User=nodechat
Group=nodechat
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN src/gateway.js --host 0.0.0.0 --port $PORT --upstream 127.0.0.1:$UPSTREAM --root $APP_DIR/public
Restart=always
RestartSec=2

# 监听 80/443 这类特权端口，但不给 root 权限
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=$APP_DIR
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable node-chat-web >/dev/null 2>&1 || true
systemctl restart node-chat-web
ok "服务已启动（node-chat-web.service）"

blue "==> 4/5 放通系统防火墙"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp >/dev/null && ok "ufw 已放通 $PORT/tcp"
else
  warn "系统防火墙未启用（ufw 未激活），跳过"
fi

blue "==> 5/5 自检"
sleep 1
if systemctl is-active --quiet node-chat-web; then
  ok "进程在跑"
else
  journalctl -u node-chat-web -n 30 --no-pager || true
  die "服务没起来，看上面的日志"
fi

if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  ok "本地探活通过：$(curl -fsS "http://127.0.0.1:$PORT/healthz")"
else
  warn "本地探活失败，可能是端口被占或启动慢"
fi

IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || echo '<公网IP>')"
echo
ok "网页端地址：http://$IP:$PORT/"
echo "   查看日志：sudo journalctl -u node-chat-web -f"
echo "   重启：    sudo systemctl restart node-chat-web"
echo "   改端口：  sudo bash install-web.sh 8080 $UPSTREAM"
warn "云厂商安全组要单独放通 $PORT 端口，否则外网打不开"
