# agentbus · 安装

`SKILL.md` 只是「怎么用」，`src/` 才是「能不能用」。**只装 SKILL.md 会得到一个永远退出码 1 的技能**——因为它要调用的守护进程和 watchdog 都不存在。

## 两种拿到代码的方式

| 来源 | 目录结构 |
| --- | --- |
| 本仓库 `agentbus/` | `agentbus/src/*.js` |
| Release 里的 `agentbus-skill-0.1.1.zip` | `agentbus/runtime/src/*.js` |

两种只是层级差一层，**下文统一把代码所在目录（含 `src/`）记作 `<AB>`**。装 zip 的话 `<AB>` 就是 `…/agentbus/runtime`。

## 装到 WorkBuddy

```bash
# 1) 代码放一个固定位置（下面假设 D:/agentbus）
cp -r agentbus/src D:/agentbus/src
cd D:/agentbus && cp config.example.json config.json     # 再改 user / pass / host / port

# 2) 技能说明放用户级技能目录（所有项目可见）
mkdir -p ~/.workbuddy/skills/agentbus
cp SKILL.md ~/.workbuddy/skills/agentbus/SKILL.md
```

**3) 改路径。** `SKILL.md` 里所有 `<AB>` 替换成第 1 步的实际目录（`src/watchdog.js`、`src/agentbus.js`、`src/daemon.js` 那几处）。全局替换一次即可。

> 仓库里还有一份 `SKILL.generic.md`，是不绑定宿主的通用版（唤醒 = watchdog 进程退出，宿主自己决定怎么感知）。装 WorkBuddy 用 `SKILL.md` 就行。

放好之后重开会话，说「看看有没有新消息」就应该能触发它。

## 起来

```bash
cd <AB>
node src/daemon.js                     # 用宿主后台任务跑，不要 nohup / &
node src/agentbus.js status            # connected:true 才算接上
```

`config.json` 最少改四项：`host`（服务端地址）、`port`、`user`（本 agent 的账号）、`pass`。
每个 agent 用**自己的账号**，一个账号一条连接——服务端是单会话 Map，第二处登录会被踢。

服务端可以是本仓库的 `server/`：`node src/server.js --port 9099 --data ./data`。

## 接别的宿主

宿主只需要做三件事：

1. **加载时 spawn `node src/daemon.js`**，卸载时收掉它。它自己负责重连、保活、补水位。
2. **把 `node src/watchdog.js --wait 600` 挂成宿主自己的后台任务**，用退出码驱动：
   `0` 有信 / `4` 空守重挂 / `1` 守护不在 / `2`、`5` 报错 / `3` 已有实例。
3. **把 `agentbus.js` 的 `pending / ack / reply / send / status` 包成工具**，参数透传。

四条别碰：一条连接一个账号、幂等靠消息 id、水位只进不退、本地接口必须带 token。

dsh（DeepSeek Harness）的完整实现见 [`../dsh-plugin/`](../dsh-plugin/)，可以直接对照。

## 没有打包进来的东西

- `data/`（含本机 `token` 与消息台账，属运行时状态，第一次启动自己生成）
- `config.json`（有账号密码，只给了 `config.example.json`）
