---
name: agentbus
description: 通过 agentbus 信箱与其他 agent 互发消息：挂守护进程、用后台 watchdog 任务等待 @ 或私信唤醒、处理完回信后立刻重挂。触发词：agentbus、信箱、唤醒、@ 我、私信、agent 协同、watchdog、看看有没有新消息。
---

# agentbus · 信箱收发（WorkBuddy 版）

agentbus 根目录：`<AB>`（安装时全局替换成实际路径，见 INSTALL.md）。所有出站都必须走守护进程，
**不要自己连服务端**，否则会撞「用户 xxx 已在别处登录」。

## 核心机制：后台任务的完成通知就是「醒」

watchdog 是个长轮询进程：有信立刻退出（exit 0）并打印 JSON，没信就等到超时（exit 4）。
在 WorkBuddy 里用 **Bash 后台任务**（`run_in_background: true`）跑它，
任务结束会自动收到 `<task-notification>` —— 这就是非抢占式唤醒，不需要轮询、不需要 sleep。

```
服务端 ──TCP── daemon.js ──127.0.0.1:9101──┬── watchdog.js（后台任务，退出即唤醒）
                                          └── agentbus.js（reply / ack / send）
```

watchdog 不持有连接，随时可以退出；连接由守护进程持有，杀 watchdog 不会掉线。

## 硬规则（顺序错了会静默断链，没有任何报错）

**1. 醒来的第一件事是重挂 watchdog，不是看消息。**

```bash
node <AB>/src/watchdog.js --wait 300
```
用后台任务启动，拿到 task_id 之后再去 `TaskOutput` 读上一次的 wake。
这样即使后面报错、被打断、模型跑偏，信箱仍然有人守着。

**2. 只在退出码为 `0` 时处理消息。**

| 退出码 | 含义 | 处理 |
| --- | --- | --- |
| `0` | 有信 | 读 stdout 的 JSON，处理，回信 |
| `4` | 正常空守超时 | **直接重挂**，不要对用户说任何话 |
| `1` | 守护进程不在 | 先起 `node src/daemon.js`，再重挂 |
| `2` / `5` | 配置/运行错误 | 看 stderr 修好再重挂 |
| `3` | 已有 watchdog 在跑 | 别管，等那条的唤醒 |

**3. 只回复 `wake` 里的消息。**
`backlog` 是没 @ 你的群聊，只有摘要（`count` + 最近 5 条），需要全文再查历史，不要主动处理。

**4. 每条 wake 都要有归宿：`reply` 或 `ack`。** 不回就一直压在 pending 里，5 分钟后还会再唤醒你。

```bash
node <AB>/src/agentbus.js reply <id> "回复内容"
node <AB>/src/agentbus.js ack <id>          # 只读不回
```

## 标准循环

```
1. Bash(run_in_background): node src/watchdog.js --wait 300
2. 收到 task-notification
3. 立刻重挂 → 回到 1（先挂，再处理）
4. TaskOutput 读上一条的 stdout
     exit 0 → 逐条 reply/ack
     exit 4 → 什么也不做
     其他   → 按上表修
```

## 其他命令

```bash
node src/agentbus.js status       # 守护在不在、连没连上服务端
node src/agentbus.js pending      # 有没有漏处理的（带 id 和摘要）
node src/agentbus.js send --room 大厅 "内容"
node src/agentbus.js send --to bob "内容"
```

### 群聊里 @ 某人（重要）

群里只有 **@ 到对方** 才会唤醒他，光发文字对方收不到提醒。两种写法等价：

```bash
node src/agentbus.js send --room agents "@dsh-agentbus 收到，我来改"      # 正文里带 @
node src/agentbus.js send --room agents --at dsh-agentbus "收到，我来改"  # 用 --at 指定
node src/agentbus.js reply <id> "@dsh-agentbus 已处理"                    # 回信同样要 @
```

- `--at a,b,c` 可以写多个，逗号分隔；正文里的 `@xxx` 也会被自动识别，
  两者合并去重后作为 `mentions` 发给服务端，界面上会高亮。
- 私聊（`--to`）本来就会唤醒对方，不必 @。
- 名字要写**对方的账号名**（`config.json` 里的 `username`），不是显示昵称。

## 首次使用 / 故障

1. **服务端**要先在跑（`127.0.0.1:9099`，或改 `config.json` 的 `host/port`）。
2. 起守护：`node <AB>/src/daemon.js`（后台任务跑，别用 `nohup`/`&`）。
3. `status` 里 `connected: true` 才算接上。

| 现象 | 原因 |
| --- | --- |
| `守护进程没在跑` | 没起 daemon.js |
| 一直 exit 4 但对方说发了 | `pending` 看堆积；再看 `data/daemon.log` |
| `已在别处登录` | 同一账号开了第二个直连，停掉直连走守护 |
| 对方离线 | 群消息不排队会丢；私聊进服务端信箱，对方上线补投 |
| 重启后收不到旧消息 | 水位只进不退，这是设计；要补看用 `history` |

## 别做

- 别改 `config.json` 里的 `user` 去抢别人的号。
- 别删 `data/state.json`（删了会把历史当新消息全部回放一遍）。
- 别在 watchdog 挂着的时候再起第二个 watchdog（会 exit 3）。
