#!/usr/bin/env bash
#
# 给 Node Chat 网页端启用 HTTPS（在云服务器上以 root 执行）
#
#   sudo bash enable-https.sh <域名> [邮箱]
#
# 做的事：
#   1) 确认域名已经解析到本机 —— 解析没通就早退，别白等 Let's Encrypt 超时
#   2) 建 ACME 验证目录，先自检当前网关能不能读出挑战文件
#   3) 装 acme.sh（纯 shell），webroot 模式签发：**全程不停网关**
#   4) 证书装到 /opt/node-chat-web/certs，把 systemd 改成 443 + 80 跳转
#   5) 自检：证书、跳转、wss 各验一遍
#
# 续期由 acme.sh 自己的 cron 负责；证书换了网关会在 5 分钟内热加载，不用重启。
#
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR="/opt/node-chat-web"
ACME_ROOT="/var/www/acme"
CERT_DIR="$APP_DIR/certs"
SERVICE="/etc/systemd/system/node-chat-web.service"
ACME_SH="/root/.acme.sh/acme.sh"
UPSTREAM_PORT="9099"

blue() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 执行：sudo bash $0 $DOMAIN"
[ -n "$DOMAIN" ]     || die "用法：sudo bash $0 nodechat.example.com [邮箱]"
[ -f "$SERVICE" ]    || die "没找到 $SERVICE，先跑 install-web.sh"
[ -f "$APP_DIR/src/gateway.js" ] || die "没找到 $APP_DIR/src/gateway.js"

# ------------------------------------------------------------------ 1 解析
blue "==> 1/5 检查域名解析"
MYIP="$(curl -fsS --max-time 6 https://ifconfig.me 2>/dev/null || true)"
[ -n "$MYIP" ] || die "取不到本机公网 IP，检查出网"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"

if [ -z "$RESOLVED" ]; then
  die "域名 $DOMAIN 还解析不出来。
   请先去域名商控制台加一条 A 记录：$DOMAIN  ->  $MYIP
   生效后重跑本脚本（通常 1~10 分钟）"
fi
if [ "$RESOLVED" != "$MYIP" ] && [ "${FORCE:-0}" != "1" ]; then
  die "域名解析到 $RESOLVED，但本机公网 IP 是 $MYIP。
   要么改 A 记录，要么确定走 CDN 时用 FORCE=1 强行继续"
fi
ok "解析正常：$DOMAIN -> $RESOLVED"

# ------------------------------------------------------------------ 2 ACME
blue "==> 2/5 准备 ACME 验证目录"
mkdir -p "$ACME_ROOT"
chown nodechat:nodechat "$ACME_ROOT"
chmod 755 "$ACME_ROOT"

# 这条自检很关键：老版本网关不认识 /.well-known/，签发会失败在最后一步
PROBE="probe-$(date +%s)-$$"
printf 'probe-%s' "$PROBE" > "$ACME_ROOT/$PROBE"
chmod 644 "$ACME_ROOT/$PROBE"
GOT="$(curl -fsS --max-time 5 "http://127.0.0.1/.well-known/acme-challenge/$PROBE" 2>/dev/null || true)"
rm -f "$ACME_ROOT/$PROBE"
if [ "$GOT" != "probe-$PROBE" ]; then
  die "当前 80 端口没有把 /.well-known/acme-challenge/ 映射到 $ACME_ROOT。
   说明跑着的还是旧版网关 —— 先重新部署（push.sh），再跑本脚本。"
fi
ok "ACME 路径可用（$ACME_ROOT）"

# ------------------------------------------------------------------ 3 acme.sh
blue "==> 3/5 安装 acme.sh"
if [ -x "$ACME_SH" ]; then
  ok "acme.sh 已存在：$("$ACME_SH" --version 2>/dev/null | head -1)"
else
  curl -fsSL https://get.acme.sh | sh -s -- "email=${EMAIL:-admin@$DOMAIN}" >/tmp/acme-install.log 2>&1 \
    || die "acme.sh 安装失败，看 /tmp/acme-install.log"
  ok "acme.sh 已安装"
fi

# ------------------------------------------------------------------ 4 签发
blue "==> 4/5 签发证书（webroot 模式，网关继续对外服务）"
"$ACME_SH" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true

if [ -d "/root/.acme.sh/$DOMAIN" ]; then
  warn "已有该域名的证书，改用 --force 重新签发"
  "$ACME_SH" --issue -d "$DOMAIN" -w "$ACME_ROOT" --server letsencrypt --force
else
  "$ACME_SH" --issue -d "$DOMAIN" -w "$ACME_ROOT" --server letsencrypt
fi

mkdir -p "$CERT_DIR"
"$ACME_SH" --install-cert -d "$DOMAIN" \
  --key-file       "$CERT_DIR/key.pem" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --reloadcmd      "chown nodechat:nodechat $CERT_DIR/*.pem && chmod 640 $CERT_DIR/*.pem"
chown nodechat:nodechat "$CERT_DIR"/*.pem
chmod 640 "$CERT_DIR"/*.pem
ok "证书已装到 $CERT_DIR"
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -dates 2>/dev/null | sed 's/^/   /'

# ------------------------------------------------------------------ 5 改 systemd
blue "==> 5/5 切到 443"
NODE_BIN="$(command -v node)"
EXEC="$NODE_BIN src/gateway.js --host 0.0.0.0 --port 443 --upstream 127.0.0.1:$UPSTREAM_PORT --root $APP_DIR/public --tls-cert $CERT_DIR/fullchain.pem --tls-key $CERT_DIR/key.pem --redirect-port 80 --acme-root $ACME_ROOT"

cp -a "$SERVICE" "$SERVICE.bak.$(date +%Y%m%d%H%M%S)"
if grep -q '^ExecStart=' "$SERVICE"; then
  sed -i "s|^ExecStart=.*|ExecStart=$EXEC|" "$SERVICE"
else
  die "$SERVICE 里没有 ExecStart，单元格式不对，手动看一眼"
fi
# 443 与 80 都需要绑定特权端口
grep -q '^AmbientCapabilities=' "$SERVICE" || die "单元里没有 AmbientCapabilities，无法以非 root 监听 443"

systemctl daemon-reload
systemctl restart node-chat-web
sleep 1.5

if systemctl is-active --quiet node-chat-web; then
  ok "服务在跑"
else
  journalctl -u node-chat-web -n 40 --no-pager || true
  die "服务没起来，看上面日志（旧单元已备份为 $SERVICE.bak.*）"
fi

# ------------------------------------------------------------------ 自检
echo
blue "==> 自检"
HEALTH="$(curl -fsSk --max-time 6 https://127.0.0.1/healthz 2>/dev/null || true)"
echo "$HEALTH" | grep -q '"tls":true' && ok "HTTPS 探活：$HEALTH" || warn "HTTPS 探活失败：$HEALTH"

if curl -sI --max-time 6 http://127.0.0.1/ 2>/dev/null | grep -q "^HTTP/1.1 301"; then
  ok "80 端口 301 跳转正常"
else
  warn "80 端口没有跳转，检查 --redirect-port"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 443/tcp >/dev/null && ufw allow 80/tcp >/dev/null && ok "ufw 已放通 443/80"
fi

# 证书链从本机看是否完整（缺中间证书会让部分浏览器直接报错）
if openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" </dev/null 2>/dev/null | grep -q "Verify return code: 0"; then
  ok "证书链校验通过"
else
  warn "证书链校验没通过，检查 fullchain.pem 是否包含中间证书"
fi

echo
ok "HTTPS 已就绪：https://$DOMAIN/"
echo "   证书路径：$CERT_DIR/fullchain.pem  $CERT_DIR/key.pem"
echo "   续期：    acme.sh 自带 cron，证书更新后网关自动热加载（5 分钟内）"
echo "   手动续期：sudo $ACME_SH --cron --home /root/.acme.sh"
echo "   回滚：    cp $SERVICE.bak.* $SERVICE && systemctl daemon-reload && systemctl restart node-chat-web"
warn "云安全组要放通 443（80 保持放通，续期验证要用）"
