# node-chat

零依赖的 Node.js 即时消息系统：**服务端 + 客户端 + 可脚本化的命令行接口**，支持私聊、群聊、离线信箱、消息历史、在线状态。

- 传输：TCP + NDJSON（每行一条 JSON），无需任何第三方包
- 认证：用户名 + scrypt 加盐哈希，首登自动注册
- 私聊：在线即时投递；对方离线自动进信箱，上线补发
- 群聊：加入/退出、成员列表、群消息广播、历史回溯
- 命令行：既可交互式使用，也可作为脚本 API（JSON Lines 输出便于管道处理）
- **图片消息**：客户端压缩后以 data URL 内联发送，历史可回溯
- **头像**：设置后自动同步给所有在线客户端，消息旁显示

```
node-chat/
├── src/
│   ├── protocol.js     协议定义（类型、错误码、限流、行解析器）
│   ├── store.js        JSON 文件持久化（用户/群组/历史）
│   ├── server.js       服务端（可作为库使用 createChatServer）
│   ├── client-lib.js   可编程客户端库（事件 + 请求应答）
│   ├── cli.js          命令行接口：发消息 / 收消息 / 群管理
│   ├── repl.js         交互式命令行客户端
│   └── options.js      极简参数解析
├── test/e2e.test.js    端到端测试（node --test）
└── examples/           示例脚本
```

## 快速开始

```bash
# 1. 启动服务端（--demo 会创建 alice/bob/carol，密码 123456）
node src/server.js --port 9099 --demo

# 2. 开两个终端，分别登录
node src/repl.js -u alice -k 123456 --room general
node src/repl.js -u bob   -k 123456 --room general

# 3. 在 alice 窗口里直接输入文字 → 发送到 general 群
#    /to bob 私聊你一下
```

## 命令行接口（`src/cli.js`）

这是给脚本用的**非交互**接口，每个命令用完即退，返回码 0 表示成功、1 表示失败。

```bash
# 发私聊
node src/cli.js -u alice -k 123456 msg bob "晚上一起吃饭吗？"

# 发群消息（不存在则自动建群并加入）
node src/cli.js -u alice -k 123456 group general "大家好呀"

# 收消息：持续监听，输出 JSON Lines，可直接 | jq
node src/cli.js -u alice -k 123456 listen --duration 60 --json --only-messages
node src/cli.js -u alice -k 123456 listen --duration 60 --json | jq -r '.data.text'

# 历史消息
node src/cli.js -u alice -k 123456 history --room general --limit 20
node src/cli.js -u alice -k 123456 history --with bob

# 发图片（自动转 data URL）
node src/cli.js -u alice -k 123456 group general --image ./photo.jpg
node src/cli.js -u alice -k 123456 msg bob "看看这个" --image ./photo.jpg

# 设置自己的头像（登录后立即上传）
node src/cli.js -u alice -k 123456 --set-avatar ./me.png rooms

# 群管理
node src/cli.js -u alice -k 123456 rooms
node src/cli.js -u alice -k 123456 members --room general
node src/cli.js -u alice -k 123456 join  --room dev
node src/cli.js -u alice -k 123456 leave --room dev

# 在线用户
node src/cli.js -u alice -k 123456 who
```

### 命令一览

| 命令 | 说明 |
| --- | --- |
| `msg <用户> <文本>` | 发送私聊（对方离线则进信箱） |
| `group <群名> <文本>` | 发送群消息，自动加入群 |
| `send <文本>` | 按 `--to` / `--room` 发送 |
| `listen` | 持续监听收到的消息，`--duration <秒>` 限时，`Ctrl+C` 结束 |
| `history` | 拉历史，`--room <群>` 或 `--with <用户>` |
| `rooms` / `members` / `join` / `leave` | 群管理 |
| `who` | 在线用户列表 |

### 通用选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `-h, --host` | `127.0.0.1` | 服务端地址 |
| `-p, --port` | `9099` | 服务端端口 |
| `-u, --user` | `guest` | 用户名 |
| `-k, --password` | `123456` | 密码 |
| `--image <文件>` | — | 随消息附带一张图片 |
| `--set-avatar <文件>` | — | 登录后立即把该图片设为自己的头像 |
| `--json` | 关 | 输出 JSON Lines，便于管道处理 |
| `--only-messages` | 关 | JSON 模式下只保留 msg/group |
| `--timeout` | `10000` | 单次请求超时（毫秒） |
| `--duration` | — | `listen` 模式持续时间（秒） |
| `--no-join` | — | 发群消息时不自动加入群 |

### 典型脚本用法

```bash
#!/usr/bin/env bash
set -euo pipefail
HOST=127.0.0.1; PORT=9099; USER=ci-bot; PASS=123456

# 后台监听群消息，命中关键词就触发构建
node src/cli.js -p $PORT -u $USER -k $PASS listen --duration 300 --json --only-messages \
  | while read -r line; do
      text=$(echo "$line" | jq -r '.data.text')
      if [[ "$text" == *"deploy"* ]]; then
        echo "收到部署指令: $text"
        ./deploy.sh
      fi
    done
```

## 交互式客户端（`src/repl.js`）

```bash
node src/repl.js -u alice -k 123456 --room general
```

| 命令 | 说明 |
| --- | --- |
| `/to <用户> <文本>` | 发送私聊 |
| `/image <路径> [文字]` | 发送图片到当前群 |
| `/avatar <路径>` | 设置自己的头像 |
| `/join <群名>` | 加入群并切换为当前群 |
| `/leave <群名>` | 退出群 |
| `/room <群名> [文本]` | 切换当前群，或直接发言 |
| `/rooms` / `/members [群名]` / `/who` | 查看群、成员、在线用户 |
| `/history [条数]` | 查看历史消息 |
| `/help` / `/quit` | 帮助 / 退出 |

直接输入文本 = 发送到当前群。

## 作为库使用（`src/client-lib.js`）

命令行工具只是这层 API 的一个封装，你自己的 Node 脚本可以直接用：

```js
const { connect } = require('./src/client-lib');

(async () => {
  const client = await connect({ host: '127.0.0.1', port: 9099, username: 'alice', password: '123456' });

  client.on('message', (m) => console.log(`[私聊] ${m.from}: ${m.text}`));
  client.on('group', (m) => console.log(`[群聊] ${m.room} ${m.from}: ${m.text}`));
  client.on('presence', (p) => console.log(`${p.user} ${p.online ? '上线' : '下线'}`));

  await client.joinRoom('general');
  await client.sendToRoom('general', '大家好');
  await client.sendTo('bob', '私聊一条');

  // 发图片：image 为 data URL（可用 fileToDataUrl 辅助）
  const { fileToDataUrl } = require('./src/client-lib');
  await client.sendToRoom('general', '看图', fileToDataUrl('./photo.jpg'));

  // 头像
  await client.setAvatar(fileToDataUrl('./me.png'));
  const p = await client.getAvatar('bob');

  // 等待满足条件的消息（带缓冲回溯，不会漏掉已到达的消息）
  const reply = await client.waitFor((m) => m.from === 'bob', 5000);

  const history = await client.history({ room: 'general', limit: 20 });
  client.close();
})();
```

服务端同样可以嵌入使用：

```js
const { createChatServer } = require('./src/server');
const server = await createChatServer({ port: 0, dataDir: './data' });
server.broadcast('服务器将于 10 分钟后重启');   // 向所有在线用户发公告
await server.stop();
```

### 客户端 API

| 方法 | 说明 |
| --- | --- |
| `connect(options)` / `new ChatClient(options)` | 建立连接并认证 |
| `sendTo(to, text, image?)` | 发私聊（image 为 data URL），返回 `{ delivered }` |
| `sendToRoom(room, text, image?)` | 发群消息（需已在群内） |
| `setAvatar(dataUrl)` | 设置自己的头像 |
| `getAvatar(user)` | 查询某用户头像 |
| `fileToDataUrl(path)` | 把本地图片文件转成 data URL |
| `joinRoom(room)` / `leaveRoom(room)` | 加入 / 退出群 |
| `listRooms()` / `listMembers(room)` / `who()` | 查询群与在线用户 |
| `history({ room })` / `history({ to })` | 拉取历史 |
| `waitFor(predicate, timeout)` | 等待符合条件的消息 |
| `close()` | 断开连接 |

事件：`message`（私聊）、`group`（群消息）、`presence`（上下线）、`system`（系统通知）、`avatar`（头像变更）、`profile`、`ack`、`error`、`close`、`raw`（原始帧）。

> 注意：`message` / `group` / `presence` 事件在登录瞬间就可能到达。若脚本需要绝对不漏消息，请在 `connect()` 的 `options.handlers` 里注册回调（会在建连前绑定），或使用带缓冲回溯的 `waitFor()`。

## 服务端命令行参数

```bash
node src/server.js --host 0.0.0.0 --port 9099 --data ./data --demo
```

| 选项 | 说明 |
| --- | --- |
| `--host` | 监听地址，默认 `0.0.0.0` |
| `--port` | 监听端口，默认 `9099` |
| `--data` | 数据目录，默认 `./data` |
| `--name` | 服务端名称 |
| `--demo` | 创建演示账号与 `general`/`dev` 群 |
| `--no-stdin` | 不监听标准输入广播 |

服务端启动后，直接在终端输入一行文本回车，即可向所有在线用户广播系统公告（`Ctrl+C` 退出）。

## 协议说明

传输层是 TCP，**一行一条 JSON**（NDJSON），UTF-8 编码。

### 消息信封

```json
{ "type": "msg", "id": "r1_x9", "data": { "from": "alice", "text": "hi" } }
```

- `type`：消息类型
- `data`：业务载荷
- `id`：可选。带 `id` 的请求，服务端必定回一条同 `id` 的应答（`ack` 或 `error`），客户端据此配对 Promise

### 客户端 → 服务端

| type | data | 说明 |
| --- | --- | --- |
| `auth` | `{username, password}` | 认证，首次登录自动注册 |
| `msg` | `{to, text, image?}` | 私聊（`image` 为图片 data URL） |
| `group` | `{room, text, image?}` | 群消息，需已在群内（`image` 为图片 data URL） |
| `join` | `{room}` | 加入群（不存在则创建） |
| `leave` | `{room}` | 退出群 |
| `rooms` | `{}` | 群列表 |
| `members` | `{room}` | 群成员 |
| `who` | `{}` | 在线用户 |
| `history` | `{room?, to?, limit?}` | 历史消息 |
| `profile` | `{action:'set', avatar}` / `{action:'get', user}` | 设置 / 查询头像 |
| `ping` | `{}` | 心跳 |
| `quit` | `{}` | 主动断开 |

### 服务端 → 客户端

| type | data | 说明 |
| --- | --- | --- |
| `auth_ok` | `{user, rooms, server}` | 认证成功 |
| `auth_err` | `{message}` | 认证失败 |
| `msg` | `{id, from, to, text, ts, image?, offline?}` | 收到私聊（`offline=true` 为信箱补发） |
| `group` | `{id, room, from, text, ts, image?}` | 收到群消息 |
| `join_ok` / `leave_ok` | `{room, members?, created?}` | 群操作结果 |
| `rooms` / `members` / `who` | 对应数据 | 查询结果 |
| `history` | `{scope, room?, with?, messages}` | 历史消息 |
| `ack` | `{ok, kind, message?}` | 请求成功确认 |
| `error` | `{code, message}` | 请求失败 |
| `presence` | `{user, online, at}` | 上下线广播 |
| `profile` | `{user, avatar}` | 头像查询结果 |
| `system` | `{event, ...}` | 系统通知：`announcement` / `avatar` / `user_joined` 等 |
| `pong` | `{at}` | 心跳应答 |

错误码：`unauthorized`、`bad_request`、`not_found`、`not_in_room`、`already_in_room`、`rate_limit`、`internal`。

### 用原始 socket 对接

```bash
# 认证 + 查在线用户
printf '{"type":"auth","id":"1","data":{"username":"alice","password":"123456"}}\n{"type":"who","id":"2","data":{}}\n' \
  | nc 127.0.0.1 9099
```

## 限制与安全说明

- 用户名：1–24 位，字母/数字/下划线/中文/`.`/`-`；群名 1–32 位，同规则
- 单条消息最长 4000 字符；单帧最大 1 MB（图片以 data URL 内联）
- 图片（data URL）最长 600 KB，头像最长 100 KB；历史中只保留最近 50 条消息的图片
- 每连接 10 秒内最多 60 条业务消息，超出返回 `rate_limit`
- 密码使用 scrypt + 随机盐哈希存储，明文不落盘
- 同一用户名不允许重复在线（后登录者被拒绝）
- 服务端内置心跳与空闲连接回收（5 分钟无活动断开）
- 生产环境建议再加 TLS（`tls.createServer`）与连接数限制

## 测试

```bash
npm test        # node --test，13 个用例覆盖协议、认证、私聊、群聊、历史、离线信箱、持久化
```

## 常见问题

**发群消息报「你还不是群的成员」** —— 服务端要求先入群。命令行用 `group` 命令会自动入群；用库时先调 `joinRoom()`。

**对方显示离线** —— 私聊需要目标用户在线才是即时投递；离线消息会存进信箱，对方下次登录自动补发。

**端口被占用** —— `--port` 换一个端口，或用 `--port 0` 让系统随机分配。
