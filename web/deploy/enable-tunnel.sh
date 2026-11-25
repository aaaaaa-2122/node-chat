#!/usr/bin/env bash
#
# 安装 Cloudflare named tunnel（token 模式），把公网域名指到本机网页端
#
#   ./enable-tunnel.sh <TUNNEL_TOKEN> [HOSTNAME]
#
# 例：
#   ./enable-tunnel.sh eyJhIjoi... nodechat.example.com
#
# 前置条件（必须在 Cloudflare 控制台先做完）：
#   1. 域名已接入 Cloudflare 且 NS 已生效（站点状态 Active）
#   2. Zero Trust -> Networks -> Tunnels -> Create a tunnel -> Cloudflared
#   3. 复制安装命令里的 token（eyJ 开头那一串）
#   4. 在该 tunnel 的 Public Hostname 里加：
#        Subdomain: nodechat    Domain: example.com
#        Service:   https://localhost:443
#        Additional application settings -> TLS -> No TLS Verify = ON
#
#   为什么要 443 而不是 80：网关的 --tls-host 会对匹配域名的 80 端口请求做
#   301 跳转到 https，而 tunnel 会把原始 Host 头带过来，指 80 会形成死循环。
#   走 443 则直接命中证书域名，网关正常服务；回环连接证书名不匹配，
#   所以 Public Hostname 里必须开 No TLS Verify。
#
set -euo pipefail

TOKEN="${1:-}"
HOSTNAME_ARG="${2:-nodechat.example.com}"
CF_BIN="/usr/local/bin/cloudflared"

[ -n "$TOKEN" ] || { echo "用法: $0 <TUNNEL_TOKEN> [HOSTNAME]"; exit 1; }
case "$TOKEN" in
  eyJ*) ;;
  *) echo "❌ token 格式不对（应以 eyJ 开头）"; exit 1 ;;
esac

echo "==> 检查 cloudflared"
if [ ! -x "$CF_BIN" ]; then
  echo "    未安装，尝试下载"
  GH="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
  rm -f /tmp/cloudflared
  for SRC in "https://gh-proxy.com/$GH" "$GH" "https://ghfast.top/$GH"; do
    echo "    尝试: ${SRC:0:60}..."
    if curl -sL --max-time 180 --noproxy '*' -o /tmp/cloudflared "$SRC" && [ -s /tmp/cloudflared ]; then
      if /tmp/cloudflared --version >/dev/null 2>&1 || chmod +x /tmp/cloudflared && /tmp/cloudflared --version >/dev/null 2>&1; then
        sudo install -m 755 /tmp/cloudflared "$CF_BIN"
        break
      fi
    fi
  done
  [ -x "$CF_BIN" ] || { echo "❌ cloudflared 下载失败"; exit 1; }
fi
"$CF_BIN" --version

echo "==> 停掉临时隧道（如果还在跑）"
sudo systemctl stop cfquick.service 2>/dev/null || true
sudo systemctl reset-failed cfquick.service 2>/dev/null || true

echo "==> 安装为系统服务"
sudo "$CF_BIN" service install "$TOKEN"

echo "==> 启动"
sudo systemctl enable cloudflared >/dev/null 2>&1 || true
sudo systemctl restart cloudflared
sleep 12

echo "==> 连接状态"
sudo journalctl -u cloudflared --no-pager -o cat -n 200 2>/dev/null \
  | grep -oE "Registered tunnel connection.*|location=[a-z0-9]+|error.*" | tail -6 || true

if systemctl is-active --quiet cloudflared; then
  echo "✅ cloudflared 服务运行中"
else
  echo "❌ cloudflared 未能启动，查看: sudo journalctl -u cloudflared -n 50"
  exit 1
fi

echo
echo "==> 最后一步（必须做，否则浏览器会报 502/重定向循环）"
echo "    在 Cloudflare 控制台该 tunnel 的 Public Hostname 中确认："
echo "      Subdomain: ${HOSTNAME_ARG%%.*}    Domain: ${HOSTNAME_ARG#*.}"
echo "      Service:   https://localhost:443"
echo "      No TLS Verify = ON"
echo
echo "    然后浏览器访问 https://$HOSTNAME_ARG"
