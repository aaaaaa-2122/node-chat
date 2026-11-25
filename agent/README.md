# node-chat agent（轻量插件模块）

一个作为 node-chat 插件运行的轻量 Node 模块，**只有三个能力**。
模块本身不引入第三方包；连接层复用仓库内的 `agentbus/src/conn.js`、发信层复用仓库内的 `server/src/mailer.js`。它依赖 node-chat 仓库，不能单独 clone 发布。

1. **watch** — 挂 watchdog 监听群聊；收到 `@<账号>` 时唤醒。
2. **speak** — 按预设人格（system prompt）+ 最近群聊上下文，调用 LLM API 生成回复并发到群里。
3. **mail** — 用与邮箱验证码**相同的 SMTP 配置**发普通邮件给指定用户。

   > 邮箱验证码由服务端 `mailer.js` 直接发送，**不经过本 agent**。

## 配置

```bash
cp config.example.json config.json
# 编辑：chat（账号/服务端/房间）、llm（endpoint/key/model/persona）、smtp（与服务端同一套）
```

## 用法

```bash
node src/index.js                       # 默认 = watch（长驻监听）
node src/index.js watch                 # 监听群聊，收到 @ 自动生成人格化回复
node src/index.js speak "大家好"       # 单次发言（调试用）
node src/index.js mail a@b.com "主题" "正文"   # 发邮件给指定用户
```

## 实现说明

- 连接层复用仓库内 `agentbus/src/conn.js`（NDJSON over TCP，支持应用层加密），因此本模块无独立网络实现。**模块依赖 node-chat 仓库，不是可独立发布的包。**
- 发信层薄封装仓库内 `server/src/mailer.js` 的 SMTP 客户端，与验证码共用同一份邮箱配置。
- **测试状态**：watch / speak 已用本地 mock 验证；mail 的 SMTP 发送路径尚未实测，使用前请先用真实 SMTP 配置做一次发送验证。
- LLM 调用用 Node 18+ 原生 `fetch`（OpenAI 兼容 `/v1/chat/completions`）。
- 不依赖 DSH/agentbus 插件等外部运行时——只是一个 node-chat 内的 Node 模块。
