'use strict';

/**
 * agentbus —— agent 用来操作信箱的命令行。
 *
 * 它自己不连服务端，全部请求转给守护进程；所以永远只有一个连接、一个账号。
 *
 *   status              守护进程与连接状态
 *   pending             所有未处理的消息
 *   ack <id...>         标记已读（不回复时用）
 *   reply <id> <文本>   回复并标记完成
 *   send --room <群> <文本>
 *   send --to <用户> <文本>
 */

const path = require('path');
const { loadConfig } = require('./daemon');
const { call } = require('./local');

const USAGE = [
  '用法：',
  '  node src/agentbus.js status',
  '  node src/agentbus.js pending',
  '  node src/agentbus.js ack <id> [id...]',
  '  node src/agentbus.js reply <id> <文本>',
  '  node src/agentbus.js send --room <群> <文本>',
  '  node src/agentbus.js send --to <用户> <文本>',
  '',
  '选项：--config <路径>   默认 ../config.json',
].join('\n');

function fail(msg, code) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(code || 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--config');
  const cfgPath = ci >= 0 ? argv[ci + 1] : path.join(__dirname, '..', 'config.json');
  const rest = argv.filter((a, i) => !(a === '--config' || (ci >= 0 && i === ci + 1)));

  const cmd = rest[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stderr.write(USAGE + '\n');
    process.exit(cmd ? 0 : 2);
  }

  const cfg = loadConfig(cfgPath);

  try {
    if (cmd === 'status') {
      const d = await call(cfg, 'GET', '/status');
      return done(d);
    }

    if (cmd === 'pending') {
      const d = await call(cfg, 'GET', '/pending');
      return done(d);
    }

    if (cmd === 'ack') {
      const ids = rest.slice(1);
      if (!ids.length) return fail('缺少消息 id');
      const d = await call(cfg, 'POST', '/ack', { ids: ids });
      return done(d);
    }

    if (cmd === 'reply') {
      const id = rest[1];
      const text = rest.slice(2).join(' ');
      if (!id || !text) return fail('用法：reply <id> <文本>');
      const d = await call(cfg, 'POST', '/reply', { id: id, text: text }, 30000);
      return done(d);
    }

    if (cmd === 'send') {
      let room = null;
      let to = null;
      const words = [];
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === '--room') room = rest[++i];
        else if (rest[i] === '--to') to = rest[++i];
        else words.push(rest[i]);
      }
      const text = words.join(' ');
      if ((!room && !to) || !text) return fail('用法：send --room <群> <文本> 或 send --to <用户> <文本>');
      const d = await call(cfg, 'POST', '/send', { room: room, to: to, text: text }, 30000);
      return done(d);
    }

    return fail('未知命令：' + cmd + '\n' + USAGE, 2);
  } catch (e) {
    if (e.code === 'no_daemon') return fail(e.message + '（先启动：node src/daemon.js）', 1);
    return fail(e.message, 1);
  }
}

function done(obj) {
  process.stdout.write(
    JSON.stringify(obj && obj.ok === false ? obj : Object.assign({ ok: true }, obj)) + '\n'
  );
  process.exit(0);
}

main();
