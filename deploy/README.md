# Node Chat 服务端部署包（腾讯云 CVM / 轻量应用服务器）

零依赖 Node.js 服务，一台 1 核 1G 的小机器足够跑几十人在线。

```
app/          服务端代码（src/ + package.json，无第三方依赖）
install.sh    在服务器上执行：装 Node、建用户、写 systemd、开防火墙、自检
push.sh       在本地执行：打包 → scp → ssh 安装（一键）
```

> 在**源码包**里没有 `app/`，服务端代码在相邻的 `../server/`；`push.sh` 会自动把它打成 `app/` 上传，用法不变。

## 方式一：一条命令推上去（推荐）

本地需要能 SSH 登录服务器（推荐密钥）：

```bash
cd node-chat-server-deploy

# 默认 root / 22 端口 / 默认密钥
./push.sh 43.139.xx.xx

# 指定用户、端口、私钥
./push.sh 43.139.xx.xx ubuntu 22 ~/.ssh/tencent.pem
```

脚本最后会打印公网地址、日志命令和自检结果。

## 方式二：手动上传

```bash
# 本地
tar czf deploy.tgz -C node-chat-server-deploy app install.sh
scp deploy.tgz root@43.139.xx.xx:/tmp/

# 服务器
mkdir -p ~/deploy && tar xzf /tmp/deploy.tgz -C ~/deploy
cd ~/deploy && sudo bash install.sh          # 可传参：sudo bash install.sh 9099 /var/lib/node-chat
```

## 方式三：不装 systemd，直接跑（临时试水）

```bash
scp -r node-chat-server-deploy/app root@43.139.xx.xx:/opt/node-chat
ssh root@43.139.xx.xx
cd /opt/node-chat && node src/server.js --host 0.0.0.0 --port 9099 --data ./data
# 想加演示账号：加 --demo（alice/bob/carol，密码 123456）
```

## 装完之后

**1. 放通云安全组（必须）**
腾讯云控制台 → 云服务器 / 轻量应用服务器 → 防火墙 / 安全组 → 添加入站规则：
`TCP:9099`，来源 `0.0.0.0/0`（或只填你自己的出口 IP，更安全）。

**2. 从外网验证**

```bash
# 在本地跑（仓库里的命令行客户端，全平台可用）
node ../node-chat-full-source/node-chat/src/cli.js --host 43.139.xx.xx --port 9099 -u probe -k 123456 rooms
```

返回群列表就说明通了。也可以直接 `nc -vz 43.139.xx.xx 9099` 看端口。

**3. 客户端连上去**

- 桌面端：地址 `43.139.xx.xx`，端口 `9099`，勾「记住服务器」
- 安卓端：登录页填同样的地址端口，登录成功后会自动出现在「最近的服务器」里

## 运维

```bash
systemctl status node-chat      # 状态
journalctl -u node-chat -f      # 实时日志
systemctl restart node-chat     # 重启
systemctl stop node-chat        # 停止
```

数据（账号、群、历史、头像、离线信箱）都在 `/var/lib/node-chat`，备份直接打包这个目录：

```bash
tar czf ~/node-chat-backup-$(date +%F).tgz /var/lib/node-chat
```

升级代码：把新的 `app/` 覆盖上去后 `sudo bash install.sh` 重跑一遍即可（会保留数据目录）。

## 安全建议（重要）

- **上线前先把演示账号删掉**：`--demo` 会创建 `alice/bob/carol`，密码全是 `123456`。
  `install.sh` 默认**不带** `--demo`，因此是干净的。
- 这个服务的协议是「首次登录自动注册」，即公网上任何人都能注册账号。个人用建议：
  - 安全组来源限制为自己的 IP 段；或
  - 改 `src/server.js` 里 `_handleAuth` 的首登自动注册逻辑（`store.createUser`）为仅白名单可注册。
- 传输是**明文 TCP**，密码在网络上不是加密的。只在自己人之间用；要长期公网使用建议套一层
  `stunnel` / `WireGuard`，或改用 TLS 反向代理（TCP 透传）。
- 密码在服务端用 scrypt 加盐哈希存储，数据目录权限已限制为 `nodechat` 用户。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 客户端「连接超时」 | 90% 是安全组没放通 9099；先在服务器上 `ss -lntp \| grep 9099` 确认在监听 |
| `curl: (7) Failed to connect` | 同上，或服务没起来：`journalctl -u node-chat -n 50` |
| 服务起来但立刻退出 | `journalctl` 看错误；常见是端口被占（`ss -lntp \| grep 9099`） |
| Node 版本太旧 | 脚本会装 Node 20；若企业内网访问不了 NodeSource，可先手动装 Node 18+ |
| 改了端口 | `sudo bash install.sh 10000`，同时改安全组规则 |
| 想改服务端名称 | 编辑 `/etc/systemd/system/node-chat.service` 的 `--name`，然后 `systemctl daemon-reload && systemctl restart node-chat` |
