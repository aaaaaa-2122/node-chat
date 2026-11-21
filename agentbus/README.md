# agentbus · 把聊天服务端变成 agent 的信箱

给 agent 用的收发层。核心解决一件事：**agent 的 turn 会结束，但信箱不能结束。**

配套服务端就是本仓库的 [`server/`](../server/)——任意实现同一套 NDJSON 协议的聊天服务端都能用。
两个 SKILL 文件：`SKILL.md` 是 WorkBuddy 版（唤醒 = 后台任务完成通知），`SKILL.generic.md` 是给别的宿主适配时参考的通用版。

```
服务端 ──TCP── 守护进程(daemon) ──┬── 本地 HTTP 127.0.0.1:9101 ──▶ watchdog（长轮询，等一条唤醒）
                                  └── 本地 HTTP 127.0.0.1:9101 ──▶ agentbus（发信 / ack / 回复）
```

## 为什么是三个进程而不是一个

| 角色 | 生命周期 | 不这么分的后果 |
| --- | --- | --- |
| `daemon.js` | 常驻，持有唯一的 TCP 连接 | 每个命令各连一次 → 账号被「已在别处登录」踢掉 |
| `watchdog.js` | 一次性，等到消息就退出 | 它不持连接，所以随时可退，**退出本身就是唤醒信号** |
| `agentbus.js` | 一次性，agent 主动调用 | 让 agent 自己连服务端 → 又回到一条连接上抢 |

关键点：**watchdog 退出 = 唤醒**。宿主看到后台任务结束的通知，就会开新 turn，这条链不需要宿主提供任何注入接口。

## 快速开始

```bash
cp config.example.json config.json     # 改 host/port/user/pass/rooms
node src/daemon.js                     # 常驻，前台跑；后台跑也行
node src/agentbus.js status            # {"ok":true,"connected":true,...}
node src/watchdog.js --wait 300        # 阻塞等消息，有就打印一行 JSON 并退出
```

三个终端里各跑一次，就能看到完整回路。

## 命令契约

### watchdog

```bash
node src/watchdog.js [--wait 300] [--since <ts>]
```

stdout 一行 JSON：

```json
{"ok":true,"wake":[{...消息...}],"backlog":{"count":12,"recent":[...]},"cursor":1795183868638}
```

| 退出码 | 含义 | 宿主该做什么 |
| --- | --- | --- |
| `0` | 有唤醒消息 | 处理 `wake`，回信，重挂 watchdog |
| `1` | 守护进程不在 | 先启动 daemon |
| `2` | 配置错误 | 修 config.json |
| `4` | 等到超时也没有消息 | **直接重挂**，这是正常空守 |
| `5` | 有消息但读取失败 | 看 stderr |

> `backlog` 是**只落盘不唤醒**的消息摘要（群聊里没 @ 你的），只给数量 + 最近 5 条。要全文用 `history`。这样 agent 每次醒来不会被群聊噪声灌满上下文。

### agentbus

```bash
node src/agentbus.js status
node src/agentbus.js pending                 # 所有未处理
node src/agentbus.js ack <id> [id...]        # 只读不回
node src/agentbus.js reply <id> "回复内容"    # 回复并标记完成
node src/agentbus.js send --room 大厅 "内容"
node src/agentbus.js send --to bob "内容"
```

全部输出单行 JSON，退出码 0/1。

## 唤醒策略

| 消息 | 行为 |
| --- | --- |
| 私聊给我 | **唤醒** |
| 群里 @我 | **唤醒** |
| 群里没 @我 | 只落盘（进 `backlog`） |
| 自己发的 | 忽略 |

`@` 的判定在 `daemon.js` 的 `mentions()`：只对 ASCII 用户名做边界检查，所以 `@worker` 和 `@worker，` 都命中，`@worker2` 不命中。

## 三个容易踩的坑（都已处理，改代码时别改回去）

1. **服务端 5 分钟踢人**。`session.lastActive` 只在收到客户端数据时刷新，纯被动监听 5 分钟就被 destroy。所以 `conn.js` 每 120 秒发一次 `ping`（`keepAliveMs`）。改大就等死。
2. **断线期间的群消息服务端不排队**。只有私聊有离线信箱（还是内存里的，服务端重启就丢）。所以重连后必须用 `history` 按水位补：`ts > cursor - 1000` 再按 id 去重。这是 `_backfill()` 存在的理由。
3. **首次启动不能回放历史**。否则新装第一次启动就把服务端最近 50 条历史当成新消息全灌给 agent。`store.load()` 用 `state.json` 是否存在判断首次运行，把水位定在「现在」。要回放就设 `backfillHistory: true`。

## 目录与文件

```
config.json        配置（首次运行 cp 一份）
data/ledger.jsonl  只追加的消息台账（状态：pending / acked / done / archived）
data/state.json    水位（cursorTs / backlogSeenTs）
data/token         本地接口令牌，0600，随机 48 位 hex
data/daemon.log    运行日志
data/daemon.pid    单例锁
```

**备份只需拷 `data/`**。删掉它就等于重置信箱。

## 适配到别的宿主（给插件作者的接口）

如果要在 DeepSeek Harness / WorkBuddy 里做成插件，**只需要实现三件事**，其余代码原样复用：

1. **起 daemon**：插件加载时 spawn `node src/daemon.js`，退出时收掉。它自己会重连、保活、补水位。
2. **接唤醒**：把 `watchdog.js` 挂成宿主的后台任务（或等价的异步原语），拿它的**退出码**驱动下一步。`0` → 把 stdout 里的 `wake` 交给 agent；`4` → 立刻重挂。
3. **暴露工具**：把 `agentbus.js` 的 5 个子命令包成工具（`inbox_pending` / `ack` / `reply` / `send`），参数直接透传本地 HTTP。

**不要碰的约定**（碰了会丢消息或重复执行）：

- 一条连接 = 一个账号。所有出站都走 daemon 的 9101，不要另开连接。
- 幂等靠消息 `id`。重投、补历史、重连都会看到重复 id，执行前必须查台账。
- 水位只能前进不能后退。`cursorTs` 后退会导致重复唤醒。
- 本地接口必须带 `x-agentbus-token`，端口只绑 `127.0.0.1`。

如果要换掉连接层（比如宿主自己已有协议实现），保留这些行为即可替换 `conn.js`：认证后 join 配置里的群、每 <300 秒发一次 ping、断线指数退避、重连后按水位补历史。

## 传输加密（可选）

`config.json` 里加 `"secure": true`，守护进程在认证前先做一次 X25519 握手，之后整条连接的每帧都是
`{"e":"..."}`（AES-256-GCM）。服务端支持明文与加密并存，所以老客户端不会被踢掉。

```bash
# 打开后启动，日志会打印服务端指纹
node src/daemon.js
# [secure] 加密已启用 · 服务端指纹 90facf62:b76ae7a1:3646cde8:dbd54d5d（首次信任，已记住）
```

指纹记在 `data/known-servers.json`（跟 `token` 同级，整目录搬迁不丢）。**指纹变了就拒绝连接**——
这条比什么都重要：否则「加密」只防得住被动窃听，防不住冒充。

要用公网就同时打开它：密码和消息不走明文了，剩下的元数据（谁跟谁、什么时候、多长）仍然暴露。

## 已知限制

- **默认明文 TCP + 首次登录自动注册**。局域网内够用；公网请开 `secure`（见上一节）或加 TLS、注册白名单。
- **一个账号只能一处在线**（服务端 `sessions` 是单会话 Map）。所以 agent 用专用账号，人用另一个账号旁观/插话。
- **群消息没有投递回执**。`ack` 里只有私聊带 `delivered` 字段。要知道群里谁离线得查 `who`。
- **`redeliverMs` 默认 5 分钟**。消息投出去但 agent 没 ack 的话，5 分钟后会被重新投递一次（这是给崩溃恢复用的，不是 bug）。
