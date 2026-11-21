#!/usr/bin/env node
'use strict';

/**
 * 可脚本化的命令行客户端接口。
 * 适合在 shell 脚本、CI、定时任务里做「发消息 / 收消息 / 群聊管理」。
 *
 *   node src/cli.js msg bob "在吗"
 *   node src/cli.js group general "大家好"
 *   node src/cli.js listen --duration 30 --json
 *   node src/cli.js history --room general --limit 20
 *
 * 所有命令都输出可读文本；加 --json 后输出 JSON Lines，便于 | jq 处理。
 */

const { connect, fileToDataUrl } = require('./client-lib');
const { PinStore } = require('./secure');
const { createParser } = require('./options');

const parse = createParser([
  'host', 'port', 'p', 'user', 'u', 'password', 'k',
  'text', 'to', 'room', 'with', 'limit', 'timeout', 'duration', 'group',
  'image', 'set-avatar', 'pin-file',
]);

const HELP = `用法: node src/cli.js <命令> [参数] [选项]

命令:
  msg <用户> <文本>            给指定用户发送私聊
  group <群名> <文本>          向指定群发送群消息（自动加入该群）
  send <文本>                  按 --to / --room 发送消息
  listen [--duration <秒>]     持续监听收到的消息（Ctrl+C 结束）
  history [--room <群> | --with <用户>] [--limit <条数>]
  rooms                        列出所有群
  members --room <群名>        查看群成员
  who                          查看在线用户
  join --room <群名>           加入群
  leave --room <群名>          退出群

通用选项:
  -h, --host <地址>        服务端地址（默认 127.0.0.1）
  -p, --port <端口>        服务端端口（默认 9099）
  -u, --user <用户名>      用户名（默认 guest）
  -k, --password <密码>    密码（默认 123456）
      --image <文件>        随消息附带一张图片（会自动转成 data URL）
      --set-avatar <文件>   登录后立即把该图片设为自己的头像
      --secure             启用传输加密（服务端同时支持明文与加密）
      --pin-file <文件>    服务端指纹记录文件（默认 ~/.nodechat/known-hosts.json）
      --pin-reset          忘掉该服务端已记录的指纹（下次连接重新信任）
      --json               以 JSON Lines 输出（便于管道处理）
      --only-messages      JSON 模式下只输出 msg/group，忽略上下线等系统事件
      --timeout <毫秒>     单次请求超时（默认 10000）
      --duration <秒>      监听模式的持续时间
      --no-join            发群消息时不自动加入群
      --help               显示本帮助

示例:
  node src/cli.js -u alice -k 123456 msg bob "晚上一起吃饭吗"
  node src/cli.js -u alice -k 123456 group general "大家好呀"
  node src/cli.js -u alice -k 123456 listen --duration 60 --json | jq .text
`;

const DEFAULTS = {
  host: '127.0.0.1',
  port: 9099,
  user: 'guest',
  password: '123456',
  timeout: 10000,
};

/** 按用户习惯格式化一条收到的事件 */
function formatIncoming(frame, asJson) {
  if (asJson) return JSON.stringify(frame);
  const d = frame.data || frame;
  if (d.event === 'announcement') return `[公告] ${d.from || '系统'}: ${d.text}`;
  if (d.from && d.to) return `[私聊] ${d.from} → ${d.to}: ${d.text}`;
  if (d.room) return `[群聊] ${d.room} | ${d.from}: ${d.text}`;
  if (d.event === 'user_joined') return `[系统] ${d.user} 上线`;
  if (d.event === 'user_left') return `[系统] ${d.user} 下线`;
  if (d.online !== undefined) return `[在线状态] ${d.user} ${d.online ? '上线' : '下线'}`;
  return `[消息] ${JSON.stringify(d)}`;
}

function out(text, asJson) {
  if (asJson) process.stdout.write(text + '\n');
  else process.stdout.write(text + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const { opts, positional } = parse(argv);
  if (opts.help || opts.h || positional[0] === 'help' || argv.length === 0) {
    console.log(HELP);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const asJson = !!opts.json;
  const host = opts.host || DEFAULTS.host;
  const port = Number(opts.port || opts.p || DEFAULTS.port);
  const username = opts.user || opts.u || DEFAULTS.user;
  const password = opts.password || opts.k || DEFAULTS.password;
  const timeout = Number(opts.timeout || DEFAULTS.timeout);

  const command = positional[0];
  const args = positional.slice(1);

  if (opts['pin-reset']) {
    new PinStore(opts['pin-file'] || undefined).remove(host, port);
    process.stderr.write(`[加密] 已忘掉 ${host}:${port} 的服务端指纹，下次连接重新信任\n`);
  }

  const client = await connect({
    host,
    port,
    username,
    password,
    timeout,
    secure: !!opts.secure,
    pinFile: opts['pin-file'],
    onFingerprint: (fp, firstTime) => {
      // 一律走 stderr，保证 --json 的 stdout 只有数据
      process.stderr.write(`[加密] 服务端指纹 ${fp}${firstTime ? '（首次信任，已记住）' : ''}\n`);
    },
  });
  client.on('error', (err) => {
    if (!asJson) process.stderr.write(`[错误] ${err.message}\n`);
  });

  // 把收到的消息统一打印（msg/group 之外的查询命令也会用到）
  const printer = (frame) => {
    if (asJson && opts['only-messages'] && frame.type !== 'msg' && frame.type !== 'group') return;
    out(formatIncoming(frame, asJson), asJson);
  };
  client.on('message', (d) => printer({ type: 'msg', data: d }));
  client.on('group', (d) => printer({ type: 'group', data: d }));
  client.on('system', (d) => printer({ type: 'system', data: d }));

  // 登录后设置头像
  if (opts['set-avatar']) {
    try {
      const dataUrl = fileToDataUrl(opts['set-avatar']);
      await client.setAvatar(dataUrl);
      out(
        asJson
          ? JSON.stringify({ ok: true, kind: 'avatar' })
          : `✅ 头像已更新（${opts['set-avatar']}）`,
        asJson
      );
    } catch (e) {
      if (asJson) out(JSON.stringify({ ok: false, error: e.message }), asJson);
      else process.stderr.write(`❌ 头像设置失败: ${e.message}\n`);
      client.close();
      process.exit(1);
    }
  }

  const exit = async (code) => {
    client.close();
    process.exit(code);
  };

  try {
    switch (command) {
      case 'msg': {
        const to = args[0] || opts.to;
        const text = args.slice(1).join(' ') || opts.text;
        if (!to || (!text && !opts.image)) throw new Error('用法: msg <用户> <文本> [--image <文件>]');
        const image = opts.image ? fileToDataUrl(opts.image) : undefined;
        const res = await client.sendTo(to, text, image);
        out(
          asJson
            ? JSON.stringify({ ok: true, kind: 'msg', to, delivered: res.delivered !== false })
            : `✅ 私聊已发送给 ${to}${res.delivered === false ? '（对方离线，已存入信箱）' : ''}`,
          asJson
        );
        return await exit(0);
      }

      case 'group': {
        const room = args[0] || opts.room || opts.group;
        const text = args.slice(1).join(' ') || opts.text;
        if (!room || (!text && !opts.image)) throw new Error('用法: group <群名> <文本> [--image <文件>]');
        if (!opts['no-join']) {
          const { members, exists } = await client.listMembers(room);
          if (!exists || !members.includes(username)) await client.joinRoom(room);
        }
        const image = opts.image ? fileToDataUrl(opts.image) : undefined;
        const res = await client.sendToRoom(room, text, image);
        out(
          asJson
            ? JSON.stringify({ ok: true, kind: 'group', room, id: res.message && res.message.id })
            : `✅ 群消息已发送到「${room}」`,
          asJson
        );
        return await exit(0);
      }

      case 'send': {
        const text = args.join(' ') || opts.text;
        if (!text && !opts.image) throw new Error('用法: send <文本> --to <用户> 或 --room <群名>');
        const image = opts.image ? fileToDataUrl(opts.image) : undefined;
        if (opts.room) {
          if (!opts['no-join']) {
            const { members, exists } = await client.listMembers(opts.room);
            if (!exists || !members.includes(username)) await client.joinRoom(opts.room);
          }
          await client.sendToRoom(opts.room, text, image);
          out(asJson ? JSON.stringify({ ok: true, kind: 'group', room: opts.room }) : `✅ 群消息已发送到「${opts.room}」`, asJson);
        } else if (opts.to) {
          const res = await client.sendTo(opts.to, text, image);
          out(
            asJson
              ? JSON.stringify({ ok: true, kind: 'msg', to: opts.to, delivered: res.delivered !== false })
              : `✅ 私聊已发送给 ${opts.to}`,
            asJson
          );
        } else {
          throw new Error('请用 --to 或 --room 指定接收方');
        }
        return await exit(0);
      }

      case 'listen': {
        if (opts.room) {
          const { members, exists } = await client.listMembers(opts.room);
          if (!exists || !members.includes(username)) await client.joinRoom(opts.room);
        }
        const started = Date.now();
        const duration = opts.duration ? Number(opts.duration) * 1000 : 0;
        process.stderr.write(
          asJson
            ? ''
            : `👂 正在监听消息（${opts.room ? `群 ${opts.room} ` : ''}），按 Ctrl+C 结束...\n`
        );
        if (duration > 0) {
          setTimeout(() => {
            client.close();
            process.exit(0);
          }, duration).unref();
        }
        const keepAlive = setInterval(() => {}, 1 << 30);
        process.on('SIGINT', () => {
          clearInterval(keepAlive);
          client.close();
          process.exit(0);
        });
        return undefined;
      }

      case 'history': {
        const limit = Number(opts.limit || 20);
        const scope = opts.room ? { room: opts.room } : opts.with ? { to: opts.with } : null;
        if (!scope) throw new Error('请用 --room 或 --with 指定查询范围');
        const res = await client.history({ ...scope, limit });
        if (asJson) {
          out(JSON.stringify({ scope: res.scope, room: res.room, with: res.with, messages: res.messages }), asJson);
        } else {
          if (!res.messages.length) out('（暂无历史消息）', asJson);
          for (const m of res.messages) {
            const time = new Date(m.ts).toLocaleString('zh-CN');
            const body = m.room ? `[${m.room}] ${m.from}: ${m.text}` : `${m.from} → ${m.to}: ${m.text}`;
            out(`${time}  ${body}`, asJson);
          }
        }
        return await exit(0);
      }

      case 'rooms': {
        const res = await client.listRooms();
        if (asJson) out(JSON.stringify(res.rooms), asJson);
        else if (!res.rooms.length) out('（暂无群组）', asJson);
        else for (const r of res.rooms) out(`• ${r.name}  成员 ${r.memberCount} 人`, asJson);
        return await exit(0);
      }

      case 'members': {
        const room = opts.room;
        if (!room) throw new Error('请用 --room 指定群名');
        const res = await client.listMembers(room);
        if (asJson) out(JSON.stringify(res), asJson);
        else out(res.members.length ? `「${room}」成员: ${res.members.join(', ')}` : `「${room}」暂无成员`, asJson);
        return await exit(0);
      }

      case 'who': {
        const res = await client.who();
        if (asJson) out(JSON.stringify(res.users), asJson);
        else out(`在线用户 (${res.users.length}): ${res.users.join(', ')}`, asJson);
        return await exit(0);
      }

      case 'join': {
        const room = opts.room;
        if (!room) throw new Error('请用 --room 指定群名');
        const res = await client.joinRoom(room);
        out(asJson ? JSON.stringify(res) : `✅ 已加入群「${room}」${res.created ? '（新建）' : ''}`, asJson);
        return await exit(0);
      }

      case 'leave': {
        const room = opts.room;
        if (!room) throw new Error('请用 --room 指定群名');
        const res = await client.leaveRoom(room);
        out(asJson ? JSON.stringify(res) : `✅ 已退出群「${room}」`, asJson);
        return await exit(0);
      }

      default:
        console.error(`未知命令: ${command}\n`);
        console.log(HELP);
        return await exit(1);
    }
  } catch (err) {
    if (asJson) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    else process.stderr.write(`❌ ${err.message}\n`);
    return await exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`❌ ${err.message}\n`);
  process.exit(1);
});
