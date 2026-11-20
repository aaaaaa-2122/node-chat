#!/usr/bin/env bash
#
# Node Chat 服务端一键安装（在云服务器上以 root 执行）
#
#   sudo bash install.sh [端口] [数据目录]
#
# 做的事：
#   1) 检查 / 安装 Node.js（>= 18，NodeSource 源）
#   2) 建系统用户 nodechat，代码放 /opt/node-chat，数据放 /var/lib/node-chat
#   3) 写 systemd 单元并启动，开机自启
#   4) 放通本机防火墙（云厂商安全组仍需在控制台手动放通）
#
set -euo pipefail

PORT="${1:-9099}"
DATA_DIR="${2:-/var/lib/node-chat}"
APP_DIR="/opt/node-chat"
SERVICE="/etc/systemd/system/node-chat.service"
HERE="$(cd "$(dirname "$0")" && pwd)"

blue() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 执行（sudo bash install.sh）"
[ -f "$HERE/app/src/server.js" ] || die "没找到 app/src/server.js，请在解压后的目录里执行"

blue "==> 1/5 检查 Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  cur="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
  major="${cur%%.*}"
  if [ "${major:-0}" -ge 18 ]; then
    need_node=0
    ok "已有 Node.js v$cur"
  else
    warn "现有 Node.js v$cur 太旧（需要 >=18）"
  fi
fi

if [ "$need_node" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    blue "    用 apt 安装 Node.js 20（NodeSource）"
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    if ! curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource.sh; then
      die "下载 NodeSource 脚本失败，请检查服务器能否访问外网"
    fi
    bash /tmp/nodesource.sh >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    blue "    用 dnf/yum 安装 Node.js 20（NodeSource）"
    PM="$(command -v dnf || command -v yum)"
    "$PM" install -y -q curl ca-certificates >/dev/null
    curl -fsSL https://rpm.nodesource.com/setup_20.x -o /tmp/nodesource.sh || die "下载 NodeSource 脚本失败"
    bash /tmp/nodesource.sh >/dev/null
    "$PM" install -y -q nodejs >/dev/null
  else
    die "不认识的发行版，请先自行安装 Node.js 18+"
  fi
  command -v node >/dev/null 2>&1 || die "Node.js 安装后仍不可用"
  ok "已安装 Node.js $(node -v)"
fi

NODE_BIN="$(command -v node)"

blue "==> 2/5 创建用户与目录"
if ! id -u nodechat >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin -d "$APP_DIR" -M nodechat 2>/dev/null \
    || useradd -r -s /sbin/nologin -d "$APP_DIR" -M nodechat
  ok "已创建系统用户 nodechat"
else
  ok "用户 nodechat 已存在"
fi
mkdir -p "$APP_DIR" "$DATA_DIR"
rm -rf "$APP_DIR/src"
cp -r "$HERE/app/src" "$APP_DIR/src"
cp "$HERE/app/package.json" "$APP_DIR/package.json"
chown -R nodechat:nodechat "$APP_DIR" "$DATA_DIR"
chmod -R a+rX "$APP_DIR"
ok "代码已放到 $APP_DIR，数据目录 $DATA_DIR"

blue "==> 3/5 写入 systemd 单元"
cat > "$SERVICE" <<EOF
[Unit]
Description=Node Chat server (NDJSON over TCP, port ${PORT})
Documentation=file://${APP_DIR}/README-upstream.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nodechat
Group=nodechat
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/src/server.js --host 0.0.0.0 --port ${PORT} --data ${DATA_DIR} --name "Node Chat" --no-stdin
Restart=always
RestartSec=2
# 安全加固：关掉提权、保护系统目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LimitNOFILE=65535
StandardOutput=journal
StandardError=journal
SyslogIdentifier=node-chat

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable node-chat >/dev/null 2>&1 || true
systemctl restart node-chat
ok "服务已启动并设置开机自启"

blue "==> 4/5 放通本机防火墙"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null && ok "ufw 已放通 ${PORT}/tcp"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null
  firewall-cmd --reload >/dev/null
  ok "firewalld 已放通 ${PORT}/tcp"
else
  ok "本机防火墙未启用（或未装 ufw/firewalld），无需处理"
fi

blue "==> 5/5 自检"
sleep 1
if ! systemctl is-active --quiet node-chat; then
  warn "服务没起来，最近日志："
  journalctl -u node-chat -n 30 --no-pager || true
  exit 1
fi
if ss -lntp 2>/dev/null | grep -q ":${PORT} "; then
  ok "已在 0.0.0.0:${PORT} 监听"
else
  warn "没看到 ${PORT} 端口监听，请检查 journalctl -u node-chat"
fi

# 公网 IP：优先腾讯云元数据（内网也能取到），再退回外部服务
PUBIP="$(curl -fsS --max-time 2 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null || true)"
[ -n "$PUBIP" ] || PUBIP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
echo
ok "部署完成"
echo "   公网地址 : ${PUBIP:-<你的服务器公网IP>}:${PORT}"
echo "   数据目录 : ${DATA_DIR}"
echo "   查看日志 : journalctl -u node-chat -f"
echo "   重启服务 : systemctl restart node-chat"
echo
warn "还差一步：到腾讯云控制台「安全组 / 防火墙」放通 TCP ${PORT}，否则外网连不上"
echo
echo "客户端连接方式："
echo "   桌面端   : 地址填 ${PUBIP:-<公网IP>}，端口 ${PORT}"
echo "   安卓端   : 登录页填同样的地址端口（会自动记住）"
echo "   命令行   : node src/cli.js --host ${PUBIP:-<公网IP>} --port ${PORT} -u alice -k <密码> rooms"
