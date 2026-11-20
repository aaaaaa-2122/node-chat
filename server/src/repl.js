#!/usr/bin/env node
'use strict';

/**
 * 交互式命令行客户端（REPL）。
 *
 *   node src/repl.js -u alice -k 123456 --room general
 *
 * 常用命令:
 *   /to <用户> <文本>     发送私聊
 *   /join <群名>          加入群
 *   /leave <群名>         退出群
 *   /room <群名>          切换当前群（也可用 /room <群名> <文本> 直接发言）
 *   /rooms                列出所有群
 *   /members [群名]       查看群成员
 *   /who                  查看在线用户
 *   /history [条数]       查看当前群（或 --with 用户）的历史消息
 *   /help                 帮助
 *   /quit                 退出
 * 直接输入文本 = 发送到当前群。
 */

const readline = require('readline');
const { connect, fileToDataUrl } = require('./client-lib');
const { createParser } = require('./options');

const parse = createParser(['host', 'port', 'p', 'user', 'u', 'password', 'k', 'room', 'with', 'limit']);

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m',
};

function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

async function main() {
  const { opts } = parse(process.argv.slice(2));
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port || opts.p || 9099);
  const username = opts.user || opts.u || 'guest';
  const password = opts.password || opts.k || '123456';

  const client = await connect({ host, port, username, password });
  let currentRoom = opts.room || null;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  const promptText = () => {
    const scope = currentRoom ? `${C.cyan}${currentRoom}${C.reset}` : `${C.gray}未选群${C.reset}`;
    return `${C.green}${username}${C.reset}${C.dim}@${C.reset}${scope}${C.dim}>${C.reset} `;
  };
  const refreshPrompt = () => {
    rl.setPrompt(promptText());
    rl.prompt();
  };

  const write = (text) => rl.output.write(text + '\n');

  // ------------------------------------------------------------ 收消息
  client.on('message', (d) => {
    write(`${C.dim}${timestamp()}${C.reset} ${C.magenta}[私聊] ${d.from}${C.reset}: ${d.text}`);
    if (d.image) write(`${C.dim}   [图片] ${Math.round((d.image.length * 0.75) / 1024)}KB${C.reset}`);
    refreshPrompt();
  });
  client.on('group', (d) => {
    write(`${C.dim}${timestamp()}${C.reset} ${C.cyan}[${d.room}] ${d.from}${C.reset}: ${d.text}`);
    if (d.image) write(`${C.dim}   [图片] ${Math.round((d.image.length * 0.75) / 1024)}KB${C.reset}`);
    refreshPrompt();
  });
  client.on('system', (d) => {
    if (d.event === 'announcement') write(`${C.yellow}[公告] ${d.from || '系统'}: ${d.text}${C.reset}`);
    else if (d.event === 'member_joined') write(`${C.gray}[系统] ${d.user} 加入了群 ${d.room}${C.reset}`);
    else if (d.event === 'member_left') write(`${C.gray}[系统] ${d.user} 退出了群 ${d.room}${C.reset}`);
    else if (d.event === 'user_joined') write(`${C.gray}[系统] ${d.user} 上线${C.reset}`);
    else if (d.event === 'user_left') write(`${C.gray}[系统] ${d.user} 下线${C.reset}`);
    refreshPrompt();
  });
  client.on('presence', (d) => {
    write(`${C.gray}[在线状态] ${d.user} ${d.online ? '上线' : '下线'}${C.reset}`);
    refreshPrompt();
  });
  client.on('error', (err) => {
    write(`${C.red}[错误] ${err.message}${C.reset}`);
    refreshPrompt();
  });
  client.on('close', () => {
    write(`${C.red}连接已断开${C.reset}`);
    process.exit(0);
  });

  // ------------------------------------------------------------ 命令处理
  const handle = async (line) => {
    const text = line.trim();
    if (!text) return;

    if (!text.startsWith('/')) {
      if (!currentRoom) {
        write(`${C.yellow}请先用 /join <群名> 加入群，或用 /to <用户> <文本> 发私聊${C.reset}`);
        return;
      }
      await client.sendToRoom(currentRoom, text).catch((e) => write(`${C.red}发送失败: ${e.message}${C.reset}`));
      return;
    }

    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const argText = rest.join(' ');

    switch (cmd) {
      case 'to': {
        const sp = argText.indexOf(' ');
        if (sp === -1) return write(`${C.yellow}用法: /to <用户> <文本>${C.reset}`);
        const to = argText.slice(0, sp);
        const body = argText.slice(sp + 1);
        try {
          const res = await client.sendTo(to, body);
          write(
            res.delivered === false
              ? `${C.dim}(对方离线，消息已存入信箱)${C.reset}`
              : `${C.dim}(已送达 ${to})${C.reset}`
          );
        } catch (e) {
          write(`${C.red}发送失败: ${e.message}${C.reset}`);
        }
        return;
      }

      case 'join': {
        if (!argText) return write(`${C.yellow}用法: /join <群名>${C.reset}`);
        try {
          const res = await client.joinRoom(argText);
          currentRoom = argText;
          write(`${C.green}✅ 已加入群「${argText}」${res.created ? '（新建）' : ''}，成员: ${res.members.join(', ')}${C.reset}`);
        } catch (e) {
          write(`${C.red}加入失败: ${e.message}${C.reset}`);
        }
        return;
      }

      case 'leave': {
        if (!argText) return write(`${C.yellow}用法: /leave <群名>${C.reset}`);
        try {
          await client.leaveRoom(argText);
          if (currentRoom === argText) currentRoom = null;
          write(`${C.green}✅ 已退出群「${argText}」${C.reset}`);
        } catch (e) {
          write(`${C.red}退出失败: ${e.message}${C.reset}`);
        }
        return;
      }

      case 'room': {
        if (!argText) {
          write(`当前群: ${currentRoom || '（未选择）'}`);
          return;
        }
        const sp = argText.indexOf(' ');
        const room = sp === -1 ? argText : argText.slice(0, sp);
        const body = sp === -1 ? '' : argText.slice(sp + 1);
        try {
          const { members, exists } = await client.listMembers(room);
          if (!exists || !members.includes(username)) await client.joinRoom(room);
          currentRoom = room;
          if (body) await client.sendToRoom(room, body);
          else write(`${C.green}当前群已切换为「${room}」${C.reset}`);
        } catch (e) {
          write(`${C.red}操作失败: ${e.message}${C.reset}`);
        }
        return;
      }

      case 'rooms': {
        const res = await client.listRooms();
        if (!res.rooms.length) write(`${C.gray}暂无群组${C.reset}`);
        for (const r of res.rooms) write(`${C.cyan}• ${r.name}${C.reset} ${C.dim}成员 ${r.memberCount} 人${C.reset}`);
        return;
      }

      case 'members': {
        const room = argText || currentRoom;
        if (!room) return write(`${C.yellow}用法: /members <群名>${C.reset}`);
        const res = await client.listMembers(room);
        write(res.members.length ? `「${room}」成员: ${res.members.join(', ')}` : `「${room}」暂无成员`);
        return;
      }

      case 'who': {
        const res = await client.who();
        write(`在线用户 (${res.users.length}): ${res.users.join(', ')}`);
        return;
      }

      case 'history': {
        const limit = Number(argText || 20);
        const scope = opts.with ? { to: opts.with } : currentRoom ? { room: currentRoom } : null;
        if (!scope) return write(`${C.yellow}请先 /join 一个群，或用 --with <用户>${C.reset}`);
        const res = await client.history({ ...scope, limit });
        if (!res.messages.length) return write(`${C.gray}暂无历史消息${C.reset}`);
        for (const m of res.messages) {
          const t = new Date(m.ts).toLocaleString('zh-CN');
          write(`${C.dim}${t}${C.reset} ${m.room ? `[${m.room}] ${m.from}` : `${m.from} → ${m.to}`}: ${m.text}`);
        }
        return;
      }

      case 'image': {
        const sp = argText.indexOf(' ');
        const file = sp === -1 ? argText : argText.slice(0, sp);
        const body = sp === -1 ? '' : argText.slice(sp + 1);
        if (!file) return write(`${C.yellow}用法: /image <图片路径> [附带文字]${C.reset}`);
        if (!currentRoom) return write(`${C.yellow}请先 /join 一个群${C.reset}`);
        try {
          const dataUrl = fileToDataUrl(file);
          await client.sendToRoom(currentRoom, body, dataUrl);
          write(`${C.dim}(图片已发送到「${currentRoom}」，${Math.round((dataUrl.length * 0.75) / 1024)}KB)${C.reset}`);
        } catch (e) {
          write(`${C.red}发送失败: ${e.message}${C.reset}`);
        }
        return;
      }

      case 'avatar': {
        if (!argText) return write(`${C.yellow}用法: /avatar <图片路径>${C.reset}`);
        try {
          const dataUrl = fileToDataUrl(argText);
          await client.setAvatar(dataUrl);
          write(`${C.green}✅ 头像已更新${C.reset}`);
        } catch (e) {
          write(`${C.red}头像设置失败: ${e.message}${C.reset}`);
        }
        return;
      }

      case 'help':
        write(
          [
            `${C.bold}命令列表${C.reset}`,
            `  /to <用户> <文本>     发送私聊`,
            `  /image <路径> [文字]  发送图片到当前群`,
            `  /avatar <路径>        设置自己的头像`,
            `  /join <群名>          加入群并切换为当前群`,
            `  /leave <群名>         退出群`,
            `  /room <群名> [文本]   切换当前群，或直接发言`,
            `  /rooms                列出所有群`,
            `  /members [群名]       查看群成员`,
            `  /who                  查看在线用户`,
            `  /history [条数]       查看历史消息`,
            `  /help                 显示帮助`,
            `  /quit                 退出`,
            `${C.dim}直接输入文本则发送到当前群${C.reset}`,
          ].join('\n')
        );
        return;

      case 'quit':
      case 'exit':
        rl.close();
        client.close();
        process.exit(0);
        return;

      default:
        write(`${C.yellow}未知命令: /${cmd}，输入 /help 查看帮助${C.reset}`);
    }
  };

  // 命令串行执行：后一条命令等待前一条完成，避免并发导致顺序错乱
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain
      .then(() => handle(line))
      .catch((e) => write(`${C.red}错误: ${e.message}${C.reset}`))
      .finally(() => refreshPrompt());
  });

  rl.on('close', () => {
    // stdin 结束（如管道输入）时，等在途命令执行完再退出
    const done = () => {
      client.close();
      process.exit(0);
    };
    const guard = setTimeout(done, 3000);
    if (guard.unref) guard.unref();
    chain.then(
      () => {
        clearTimeout(guard);
        done();
      },
      () => {
        clearTimeout(guard);
        done();
      }
    );
  });

  write(`${C.bold}node-chat 交互客户端${C.reset} ${C.dim}(${host}:${port})${C.reset}`);
  write(`${C.dim}输入 /help 查看命令，Ctrl+C 退出${C.reset}`);
  refreshPrompt();
}

main().catch((err) => {
  process.stderr.write(`❌ ${err.message}\n`);
  process.exit(1);
});
