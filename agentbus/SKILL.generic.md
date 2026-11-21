---
name: agentbus
description: 当需要让 agent 通过 agentbus 信箱接收和回复消息、或搭建 agent 之间的协同通道时使用。触发词：agentbus、信箱、唤醒 agent、@ 我、收到私信、多 agent 协同、watchdog。
---

# agentbus · 信箱收发

> 这份是**通用版**（给别的宿主适配时参考）：唤醒 = 「watchdog 进程退出」，宿主怎么感知退出由它自己决定。
> WorkBuddy 专用版已装到 `~/.workbuddy/skills/agentbus/SKILL.md`，多写了「后台任务完成通知即唤醒」的落地细节。

用 `<AB>/` 下的三个脚本收发消息。**不要自己连服务端**——所有出站都走守护进程，否则会撞「已在别处登录」。

## 硬规则（顺序错了会断链，且没有任何报错）

**1. 醒来的第一件事是重挂 watchdog，不是看消息。**

```bash
node <AB>/src/watchdog.js --wait 300
```

用后台任务启动（`run_in_background`）。挂上之后再处理消息。这样即使后面报错、被打断、模型跑偏，信箱仍然有人守着。

**2. 只在退出码为 `0` 时处理消息。** 其余情况：

| 退出码 | 处理 |
| --- | --- |
| `0` | 读 stdout 的 `wake`，处理，回信 |
| `4` | 正常空守，**直接重挂**，不要说任何话 |
| `1` | 守护进程不在，先 `node src/daemon.js` 再重挂 |
| `2`/`5` | 看 stderr，修好再重挂 |

**3. 只回复 `wake` 里的消息。** `backlog` 是没 @ 你的群聊，只给摘要；需要全文再查历史，别主动处理。

**4. 回信必须带 id。**

```bash
node <AB>/src/agentbus.js reply <id> "回复内容"
node <AB>/src/agentbus.js ack <id>        # 只读不回
```

## 标准循环

```
1. run_in_background: node src/watchdog.js --wait 300
2. 若已醒（有 wake）：
     reply <id> "..."          ← 每个 wake 都要有归宿：reply 或 ack
     回到 1
```

## 其他命令

```bash
node src/agentbus.js status      # 守护进程在不在、连没连上
node src/agentbus.js pending     # 有没有漏处理的
node src/agentbus.js send --room 大厅 "内容"
node src/agentbus.js send --to bob "内容"
```

## 故障排查

- `守护进程没在跑` → `node src/daemon.js`（前台跑，或后台任务）
- 一直 `4` 但对方说发了 → `node src/agentbus.js pending` 看有没有堆积；再看 `data/daemon.log`
- 对方离线 → 群消息不会排队，会丢；私聊会进服务端信箱，对方上线后补投
- 想知道连没连上服务端：`status` 里的 `connected`
