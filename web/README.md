# Node Chat 网页端

浏览器里直接用，不用装客户端。零第三方依赖：WebSocket 握手与分帧自己实现，
前端是一个静态页 + 原生 JS，没有构建步骤。

```
浏览器 ──WebSocket──> gateway.js ──TCP/NDJSON──> server.js (:9099)
                       ↑
                   同时托管 public/ 静态页
```

## 为什么需要网关

服务端只会说「NDJSON over TCP」，浏览器开不了裸 TCP。中间这个进程做两件事：

1. 托管静态页（`public/`）
2. 把 `/ws` 升级成 WebSocket，然后**逐帧原样搬运**到上游 TCP 端口

它不懂聊天协议——浏览器发什么就转给服务端，服务端回什么就转给浏览器。
所以协议将来加字段，网关一行都不用改。

## 本地跑

```bash
# 1. 先起服务端
cd ../server && node src/server.js --port 9099 --demo

# 2. 起网关
cd ../web && node src/gateway.js --port 8080 --upstream 127.0.0.1:9099

# 3. 打开 http://127.0.0.1:8080
```

演示账号 alice / bob / carol，密码都是 `123456`；也可以随便填个新用户名（首次登录自动注册）。

## 部署到云服务器

```bash
cd web
./deploy/push.sh 203.0.113.10 ubuntu 22 ~/.ssh/id_ed25519
```

脚本会打包 `src/` + `public/` + `install-web.sh`，scp 上去，再 ssh 执行安装：

- 代码放 `/opt/node-chat-web`
- systemd 单元 `node-chat-web.service`，运行用户 `nodechat`（无登录 shell）
- 用 `AmbientCapabilities=CAP_NET_BIND_SERVICE` 让它以非 root 身份监听 80 端口
- 失败每 2 秒重启，开机自启

云厂商的**安全组/防火墙要自己放通端口**，脚本只处理系统内防火墙。

手动装也行：

```bash
sudo bash install-web.sh 80 9099
```

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | 8080 | 对外端口，80/443 需要绑定特权端口的能力 |
| `--host` | 0.0.0.0 | 监听地址 |
| `--upstream` | 127.0.0.1:9099 | 上游聊天服务端 |
| `--root` | `../public` | 静态文件目录 |
| `--max-frame` | 2 MiB | 单帧上限（图片是 data URL，别调太小） |
| `--tls-cert` / `--tls-key` | 无 | 给了证书就切 HTTPS，WebSocket 自动变 wss，前端不用改 |
| `--redirect-port` | 不启用 | 有证书时再开一个明文端口，只做 301 跳转和 ACME 验证 |
| `--acme-root` | `/var/www/acme` | ACME 验证文件目录，`/.well-known/acme-challenge/` 从这里读 |

`GET /healthz` 返回上游地址、当前连接数、是否 HTTPS 和运行时长，方便探活。

## 上 HTTPS

有了域名之后一条命令：

```bash
sudo bash enable-https.sh nodechat.example.com you@example.com
```

它做的事：**先确认域名已经解析到本机**（解析没通就早退，不白等 Let's Encrypt 超时）→
装 acme.sh → 用 webroot 模式签证书（**全程不停服务**，因为网关本来就在 80 上服务
`/.well-known/acme-challenge/`）→ 把 systemd 改成 443 监听 + 80 跳转 → 自检证书链。

续期由 acme.sh 自己的 cron 负责。**证书换了不用重启**：网关每 5 分钟看一眼证书文件的
mtime，变了就 `setSecureContext()` 热更，正在连着的 WebSocket 不会断。

几个刻意的选择：

- **签发不停服务。** webroot 模式把挑战文件写到 `/var/www/acme`，网关直接把它映射出去，
  所以不需要像 standalone 那样把 80 让出来。
- **失败就拒绝启动，不降级。** 传了证书但读不出来时进程直接退出，而不是悄悄跑明文——
  说好加密却静默明文，比起不来更危险。
- **`install-web.sh` 按证书文件判断模式。** 认证过的机器再跑一次普通部署，不会把单元
  改回明文；`PLAIN=1` 才强制明文。

## 安全说明

**没配 HTTPS 时，网页端和桌面端一样走明文**：服务端支持应用层帧加密（`secure` 握手），
但浏览器侧还没接——WebCrypto 的 X25519 在部分浏览器上仍不可用，硬做会挑浏览器版本。

- 公网上跑，**先上 HTTPS**（见上一节），这样至少传输层是加密的。
- 服务端还是「首次登录自动注册」，公网任何人都能注册账号。真要公开用，
  得先改服务端的 `_handleAuth` 加白名单。
- 国内云主机用域名对外提供 80/443 服务需要备案，没备案可能被拦——这和代码无关，
  是机房侧的策略。

## 自检

```bash
# 协议级：真实 WebSocket 客户端跑一遍认证 / 群聊 / 私聊 / 大帧 / 分片
node test/gateway.e2e.mjs

# 界面级：无头 Edge 截图，需要本地已起网关（默认 http://127.0.0.1:8090）
node test/ui-shot.mjs
```

`e2e` 会开两个 WebSocket：A 认证、发群消息和私聊，B 验证收到；另外测 90 KB 大帧、
分片重组（逐字节投喂）、ping/pong、未认证拦截。
