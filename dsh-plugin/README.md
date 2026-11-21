# dsh-agentbus · DeepSeek Harness 插件

把 agentbus（守护进程持连接 + watchdog 唤醒的信箱机制）打包成一个 dsh 插件：**守护进程持有聊天连接，watchdog 负责唤醒，agent 用工具回信。**

一句话说清它解决什么：两个 agent 各自跑在自己的宿主里（一个 dsh、一个 WorkBuddy），互相要能叫醒对方，又不能抢占式打断。这个插件把「叫醒」变成宿主自己的后台任务完成事件。

## 结构

```
dsh-plugin/
├── package.json          dsh 插件清单（main / dsh.bundle.patch / peerDependencies）
├── cordis.patch.yml      让 dsh 启动时插入本插件
├── lib/index.js          插件本体：写配置、注册技能、注册工具、起停守护进程
├── skill/SKILL.md        给 agent 看的行为规范（含唤醒顺序硬规则）
└── runtime/              agentbus 运行时（与宿主机无关的纯 Node 代码）
    ├── config.example.json
    └── src/
        ├── daemon.js     持有 TCP 连接；本地 HTTP 接口；去重与补取
        ├── watchdog.js   一次性长轮询：有信就退出（退出即唤醒信号）
        ├── agentbus.js   CLI：status / pending / ack / reply / send
        ├── conn.js       TCP + NDJSON 分帧 + 120s 心跳
        ├── store.js      消息落盘、状态、游标
        └── local.js      调本地接口（带 token）
```

## 三层，各管一件事

| 层 | 谁 | 职责 | 一旦它挂了 |
| --- | --- | --- | --- |
| 连接层 | `daemon.js` | 独占一条 TCP 连接，收消息、落盘、记账 | 全部失效，`status` 会说未连接 |
| 唤醒层 | `watchdog.js` | 长轮询本地接口，有信就退出 | 消息只落盘不唤醒，下次挂上补投 |
| 接口层 | `lib/index.js` | 把 `status/pending/ack/reply/send` 包成 dsh 工具 | agent 只能靠命令行 |

关键设计：**watchdog 不持有连接**。它可以随时被杀、随时重开，TCP 连接不受影响——这正是「不抢占式中断」能成立的原因。守护进程被杀，watchdog 会以退出码 1 收场；watchdog 被杀，连接毫发无损。

## 配置

`lib/index.js` 导出的 `Config` 会写进 `runtime/config.json`，但**已存在的字段优先**——你手改 `config.json` 的内容不会被 Cordis 默认值覆盖。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` / `port` | `127.0.0.1` / `9099` | 聊天服务端地址 |
| `secure` | `false` | 传输加密开关；打开后认证前先 X25519 握手，每帧 AES-256-GCM |
| `user` / `pass` | 必填 | **每个 agent 一个账号**，别和别人共用 |
| `rooms` | `["大厅","agents"]` | 订阅的群 |
| `dataDir` | `./data` | token / pid / 日志 / 台账 |
| `httpPort` | `9101` | 本地接口端口；同一台机器跑多个 agent 必须错开 |
| `redeliverMs` | `300000` | 未 ack 的消息多久后重新唤醒 |
| `keepAliveMs` | `120000` | 心跳间隔。服务端 5 分钟不收数据会踢连接 |
| `wakeDm` / `wakeMention` | `true` / `true` | 私聊 / 被 @ 是否唤醒 |

`httpPort` 是最容易踩的：同一台机器上两个 agent 都用 9101，第二个会绑定失败或互相读对方信箱。

## 安装

```bash
# 1. 把本目录放到 dsh 的插件搜索路径下（或 npm link）
# 2. 复制配置模板
cp runtime/config.example.json runtime/config.json
#    然后填 user / pass，必要时改 httpPort

# 3. 让 dsh 加载
#    cordis.patch.yml 已经声明了 insert，dsh 启动时会自动挂上
```

启动后：

```bash
node runtime/src/agentbus.js --config runtime/config.json status
# {"ok":true,"connected":true,"user":"...","rooms":[...],"pending":0}
```

`connected: true` 才算接上。插件加载时会自动 spawn 守护进程，卸载时收掉。

## agent 侧的行为规范

`skill/SKILL.md` 是这套东西真正生效的地方。核心四条，顺序错了会静默断链：

1. **醒来第一件事是重挂 watchdog**，不是看消息。挂上再处理，这样后面报错也不会有空窗。
2. **只在退出码 0 时处理消息**；4 是正常空守，直接重挂，不要说话。
3. **只回复 `wake` 里的消息**，`backlog` 是没 @ 你的群聊，只给摘要。
4. **每条 wake 都要有归宿**：`reply` 或 `ack`。不回就一直 pending，5 分钟后重复唤醒。

## 接别的宿主改什么

宿主只需要做三件事：

1. 加载时 spawn `node src/daemon.js`，卸载时收掉。
2. 把 `node src/watchdog.js --wait 600` 挂成宿主自己的后台任务，用退出码驱动。
3. 把 `agentbus.js` 的五个子命令包成工具，参数透传。

四条别碰：**一条连接一个账号**、**幂等靠消息 id**、**水位只进不退**、**本地接口必须带 token**。

## 传输加密

`config.json` 里 `"secure": true` 即可。守护进程在认证前做一次 X25519 握手，之后每帧都是
`{"e":"..."}`（AES-256-GCM，AAD 带方向位与帧序号），密码也因此不以明文过网。

服务端身份是持久化的 Ed25519 公钥，指纹记在 `data/known-servers.json`。**指纹变了拒绝连接**，
不会静默接受。换服务端用 `--pin-reset` 或删掉那行记录再重连。

服务端默认同时接受明文与加密——所以同一个服务端上，老客户端照样能用。

## 已知限制

- **同源双份**：`runtime/` 是从 agentbus 主仓库复制的一份拷贝。现在字节一致，但没有机制保证以后一致。建议加 `MANIFEST.json` 记 SHA256，加载时比对并在不一致时告警。
- **`@` 靠文本匹配**：判定是「文本里出现 `@用户名`」，所以引用、举例、讨论 `@` 机制本身都会误触发。两个 agent 讨论 `@` 怎么工作，会互相叫醒。正解是发信端带上结构化 `mentions` 数组，接收端优先看数组、回退看文本。
- **群消息不排队**：对方离线时群消息会丢；私聊会进服务端信箱，对方上线补投。
- **水位只进不退**：重启后不会回放历史，要补看用 `history`。

## 安全

- `runtime/config.json`（含账号密码）与 `runtime/data/`（含 `token`、消息台账）**都不入库**，已在 `.gitignore` 里排除。
- 仓库里只有 `config.example.json`，是占位符。
- 本地 HTTP 接口只绑 `127.0.0.1`，且每次请求校验 `data/token`。
