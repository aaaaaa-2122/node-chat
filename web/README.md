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
./deploy/push.sh 111.230.141.216 ubuntu 22 ../node-chat-server-deploy/.deploy_key
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
| `--tls-host` | 空（全部） | 只对这个 Host 做 301；设了之后直接打 IP 仍走明文 |

`GET /healthz` 返回上游地址、当前连接数、是否 HTTPS 和运行时长，方便探活。

## 上 HTTPS

前提是**自有域名**——能自己改 NS 委派的那种。第三方公共子域服务分给你的子域不满足
这个条件（zone 归服务方），详见下面「想用 Cloudflare 隧道绕过去」一节。

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
- **跳转只对证书里的域名生效（`--tls-host`）。** 证书里没有 IP，无条件 301 会把
  `http://<IP>/` 也推到 https，浏览器直接撞白屏告警页。设了 `--tls-host` 之后，
  非该域名的 Host 继续走明文，静态页和 WS 桥接都照常。

### 如果签下来了但外网打不开

先分清是「证书问题」还是「链路被拦」。同一台机器、同一端口，换一个 SNI 就能判断：

```bash
# 任意 SNI → 200，说明 TLS 与端口都正常
curl -sk --resolve foo.example.test:443:<服务器IP> https://foo.example.test/healthz
# 自己的域名 → RST，说明是域名被中间设备拦了
curl -sk --resolve nodechat.example.com:443:<服务器IP> https://nodechat.example.com/healthz
```

国内云主机上很常见的是**未备案域名被机房拦**：HTTP 会 302 到
`dnspod.qcloud.com/static/webblock.html`（或类似封禁页），HTTPS 直接在握手阶段被 RST。
这和代码、证书都无关，只能备案或换境外节点。另外 `.gay` 这类顶级域不在工信部批复
列表里，**根本没法备案**，所以域名方案在这种机器上走不通——直接打 IP 反而可用。

> 结论：`--tls-host` 不设时，80 端口会把所有 Host 都跳到 https。国内未备案机器一旦
> 开了 HTTPS，务必设上它，否则连 `http://<IP>/` 这种能用的入口也会被自己跳死。

### 想用 Cloudflare 隧道绕过去？先确认域名是你自己的

思路是让机器主动出站连 Cloudflare，用户访问 CF 边缘，机房只看得到一条加密长连接，
看不到里面的 SNI。链路本身能通，`enable-tunnel.sh` 负责安装。

但有两个前提和一个代价：

- **域名必须自有、且能改 NS 委派。** 第三方公共子域服务（例如 `xxx.是.gay` 这类
  由别人的 zone 免费分发子域的服务）不满足：zone 归服务方，你在自己账号里添加它只会
  永远停在 Pending Nameserver Update，因为 `是.gay` 的 NS 不由你控制。另外 CF 免费版
  只能添加二级域，`nodechat.是.gay` 这种三级域属于 Business 功能。
- **落点改不了。** 国内出口到 Cloudflare anycast 固定走美西（实测 `lax09`/`lax11`），
  `--protocol http2` 仍是 `lax01`，`--region apac` 这个区域并不存在（只有 us/eu），
  新版也移除了手动指定边缘的 `--edge`。
- **代价是延迟。** 同一台机器实测 A→B 群消息投递：经隧道 **337 ms**，直连 **14 ms**，
  差 24 倍。握手从 53 ms 涨到 800~1000 ms。功能完好，但交互明显发涩。

结论：隧道只在「已经有一个能改 NS 的自有域名」时才值得用；否则直接打 IP 更快。
装之前还要留意机器内存——QUIC 需要大缓冲，2 GB 以下的机器建议先确认余量。

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
