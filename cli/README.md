# NodeChatCli — 命令行客户端（给脚本 / Agent 调用）

单文件 Windows 控制台程序（.NET Framework 4.8，系统自带，无需安装运行时），
和桌面端、安卓端共用同一套 TCP + NDJSON 协议。**加 `--json` 后每条输出都是单行 JSON**，
退出码 `0` 成功 / `1` 出错 / `2` 用法错误，方便 Agent 直接解析。

## 快速开始

```bat
NodeChatCli.exe --host <你的服务器IP> --port 9099 -u alice -k 123456 ping
NodeChatCli.exe --host <你的服务器IP> -u alice -k 123456 group 大厅 "大家好"
NodeChatCli.exe --host <你的服务器IP> -u alice -k 123456 --json rooms
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `msg <用户> <文本>` | 私聊；对方离线会存信箱（输出 `delivered:false`） |
| `group <群> <文本>` | 群消息，默认自动加入该群（`--no-join` 可关） |
| `send <文本>` | 按 `--to` / `--room` 发送 |
| `rooms` | 群列表（含成员数） |
| `members [--room <群>]` | 群成员 |
| `who` | 在线用户 |
| `history --room <群> \| --with <用户> [--limit N]` | 历史消息 |
| `join --room <群>` / `leave --room <群>` | 加入 / 退出 |
| `listen [--duration <秒>]` | 持续收消息（默认 15 秒） |
| `ping` | 连通性 + 延迟 + 当前登录身份 |
| `avatar [用户]` / `set-avatar <图>` | 查 / 设头像 |

通用选项：`--host`、`--port`、`-u/--user`、`-k/--password`、`--json`、`--timeout <ms>`、
`--image <文件>`（超过 600KB 自动缩放压缩）、`--no-join`、`--version`、`--help`。

## 输出格式（--json）

成功：`{"ok":true,"command":"...","...":...}`，字段随命令不同，例如

```json
{"ok":true,"command":"rooms","rooms":[{"name":"大厅","memberCount":2}],"count":1}
{"ok":true,"command":"group","target":"大厅","scope":"room","message":{"id":"g...","from":"alice","text":"hi","ts":1795...}}
{"ok":true,"command":"msg","target":"bob","delivered":false,"message":{...}}
{"ok":true,"command":"ping","pong":true,"latencyMs":3,"user":"alice","server":"Node Chat","rooms":2}
```

失败（stdout 一行，退出码 1）：

```json
{"ok":false,"command":"ping","error":{"code":"auth_failed","message":"密码错误"}}
```

`listen --json` 是事件流，一行一个事件：

```json
{"event":"message","type":"group","data":{"room":"大厅","from":"bob","text":"hi","ts":1795...}}
{"event":"system","type":"system","data":{"event":"user_joined","user":"bob"}}
{"event":"presence","type":"presence","data":{"user":"bob","online":true}}
```

## Agent 调用示例

```bat
:: 1. 健康检查
NodeChatCli.exe --host <你的服务器IP> -u bot -k *** --json ping

:: 2. 发一条群消息，读 message.id 判断成功
NodeChatCli.exe --host <你的服务器IP> -u bot -k *** --json group 大厅 "部署完成"

:: 3. 监听 60 秒，把每条消息当 JSON 行消费
NodeChatCli.exe --host <你的服务器IP> -u bot -k *** --json listen --duration 60
```

```python
import json, subprocess

out = subprocess.run(
    [r"NodeChatCli.exe", "--host", "<你的服务器IP>", "-u", "bot", "-k", "***",
     "--json", "group", "大厅", "来自 Python 的消息"],
    capture_output=True, text=True, encoding="utf-8",
)
res = json.loads(out.stdout.strip().splitlines()[-1])
assert res["ok"], res
print(res["message"]["id"])
```

## 从源码构建

```bat
build.bat
:: 或
dotnet build -c Release
:: 产物: bin\Release\net48\NodeChatCli.exe
```

代码结构：`LineSocket.cs`（带超时的按行 TCP）、`ChatClient.cs`（认证 / 请求响应 / 收帧、图片压缩）、
`Program.cs`（命令与参数），`Json.cs` / `Protocol.cs` 与桌面端共用。

## 与 Node 版 CLI 的差别

Node 版（`node src/cli.js`）需要装 Node；这个 exe 是零依赖绿色版，参数基本一致，
输出多了 `--json` 结构化模式。功能等价，除了 Node 版的 REPL 交互界面没有实现。
