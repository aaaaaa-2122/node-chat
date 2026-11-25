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
  '  node src/agentbus.js reply <id> <文本> [--at 成员1,成员2]',
  '  node src/agentbus.js send --room <群> <文本> [--at 成员1,成员2]',
  '  node src/agentbus.js send --to <用户> <文本>',
  '',
  '选项：--config <路径>   默认 ../config.json',
  '      --at <成员>       @ 某人（逗号分隔可写多个；正文里的 @xxx 也会自动识别）',
  '                       群聊里必须 @ 对方，否则对方不会被唤醒',
].join('\n');

const MENTION_RE = /@([A-Za-z0-9_\u4e00-\u9fa5.-]{1,24})/g;

function splitAt(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
}

function parseMentions(text) {
  const out = [];
  if (!text) return out;
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text))) {
    const name = m[1].replace(/[.-]+$/, '');
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** --at 指定的 + 正文里的 @xxx，去重，最多 32 个 */
function mergeMentions(ats, text) {
  const out = [];
  for (const n of [...(ats || []), ...parseMentions(text)]) {
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 32);
}

/** 从 words 里剥出 --at 的值，剩下的拼成正文 */
function parseTextArgs(words, opts) {
  const ats = [];
  const rest = [];
  for (let i = 0; i < words.length; i++) {
    if (opts.includes(words[i]) && words[i] === '--at') {
      ats.push(...splitAt(words[++i]));
      continue;
    }
    rest.push(words[i]);
  }
  const text = rest.join(' ');
  return { text, mentions: mergeMentions(ats, text) };
}

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
      const parsed = parseTextArgs(rest.slice(2), ['--at']);
      const id = rest[1];
      const text = parsed.text;
      if (!id || !text) return fail('用法：reply <id> <文本> [--at 成员1,成员2]');
      const d = await call(
        cfg,
        'POST',
        '/reply',
        { id: id, text: text, mentions: parsed.mentions },
        30000
      );
      return done(d);
    }

    if (cmd === 'send') {
      let room = null;
      let to = null;
      const words = [];
      let ats = [];
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === '--room') room = rest[++i];
        else if (rest[i] === '--to') to = rest[++i];
        else if (rest[i] === '--at') ats = ats.concat(splitAt(rest[++i]));
        else words.push(rest[i]);
      }
      const text = words.join(' ');
      if ((!room && !to) || !text) return fail('用法：send --room <群> <文本> [--at 成员] 或 send --to <用户> <文本>');
      const d = await call(
        cfg,
        'POST',
        '/send',
        { room: room, to: to, text: text, mentions: mergeMentions(ats, text) },
        30000
      );
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
