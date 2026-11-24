'use strict';

/**
 * mailer.js — 零依赖 SMTP 发信模块
 * ==================================================================
 * 用 Node 原生 net/tls 实现 SMTP 客户端，无第三方依赖（符合项目零依赖原则）。
 * 用途：邮箱验证登录时给用户发 6 位验证码。
 *
 * 支持的加密方式（--smtp-secure）：
 *   tls       直接 TLS（SMTPS，常用 465）
 *   starttls  先明文 EHLO 再升级 STARTTLS（常用 587）
 *   none      明文（仅内网调试，勿在生产用）
 *
 * 配置来源（优先级从高到低）：构造入参 > 环境变量 SMTP_* > server/config.json
 * 未配置 SMTP 时进入降级模式：验证码打到服务端日志（仅开发/自建联调用）。
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const CRLF = '\r\n';
const MAX_LINE = 64 * 1024;

/** 从 config.json / 环境变量合并 SMTP 配置 */
function resolveConfig(opts = {}) {
  // 1) 构造入参
  const cfg = {
    host: opts.host,
    port: opts.port,
    secure: opts.secure, // 'tls' | 'starttls' | 'none'
    user: opts.user,
    pass: opts.pass,
    from: opts.from,
    connectTimeout: opts.connectTimeout || 10000,
  };

  // 2) 环境变量 SMTP_*
  const env = process.env;
  const envMap = {
    SMTP_HOST: 'host',
    SMTP_PORT: 'port',
    SMTP_SECURE: 'secure',
    SMTP_USER: 'user',
    SMTP_PASS: 'pass',
    SMTP_FROM: 'from',
  };
  for (const [ek, ck] of Object.entries(envMap)) {
    if (cfg[ck] === undefined && env[ek] !== undefined && env[ek] !== '') cfg[ck] = env[ek];
  }

  // 3) server/config.json
  if (cfg.host === undefined) {
    try {
      const p = path.join(__dirname, '..', 'config.json');
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const s = j.smtp || {};
        if (s.host) cfg.host = s.host;
        if (s.port) cfg.port = s.port;
        if (s.secure) cfg.secure = s.secure;
        if (s.user) cfg.user = s.user;
        if (s.pass) cfg.pass = s.pass;
        if (s.from) cfg.from = s.from;
      }
    } catch (_) { /* 配置读取失败则走降级 */ }
  }

  // 规范化
  if (cfg.port !== undefined) cfg.port = Number(cfg.port);
  if (cfg.secure === undefined) cfg.secure = cfg.port === 465 ? 'tls' : 'starttls';
  return cfg;
}

/** 是否配置了可用的 SMTP（host 配了才算） */
function isConfigured(cfg) {
  return !!(cfg && cfg.host);
}

/** 简易 SMTP 会话：逐行对话，带超时与 CRLF 结束 */
function SmtpSession(socket) {
  this.socket = socket;
  this.buf = '';
  this.pending = [];
  this.done = false;
  this.onLine = null;
  socket.on('data', (d) => {
    this.buf += d.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      this._push(line);
      if (line.length > MAX_LINE) { this.close(new Error('SMTP 响应行过长')); return; }
    }
  });
  socket.on('close', () => this.close(new Error('SMTP 连接关闭')));
  socket.on('error', (e) => this.close(e));
}
SmtpSession.prototype._push = function (line) {
  if (this.done) return;
  // 多行响应：`250-...` 中间行以 `-` 结尾，最后一行是空格
  if (/^\d{3}-/.test(line)) { this.pending.push(line); return; }
  if (/^\d{3} /.test(line)) {
    this.pending.push(line);
    const merged = this.pending.join('\n');
    this.pending = [];
    const cb = this.onLine;
    this.onLine = null;
    if (cb) cb(Number(line.slice(0, 3)), merged);
    else this.close(new Error('SMTP 未期望的响应: ' + line));
  } else if (/^\d{3}/.test(line)) {
    this.pending.push(line);
  } else {
    this.close(new Error('SMTP 响应异常: ' + line));
  }
};
SmtpSession.prototype.read = function (timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { this.done = true; reject(new Error('SMTP 等待响应超时')); }, timeoutMs);
    this.onLine = (code, line) => { clearTimeout(t); resolve({ code, line }); };
  });
};
SmtpSession.prototype.write = function (line) {
  return new Promise((resolve, reject) => {
    this.socket.write(line + CRLF, (e) => (e ? reject(e) : resolve()));
  });
};
SmtpSession.prototype.close = function (err) {
  if (this.done) return;
  this.done = true;
  try { this.socket.destroy(); } catch (_) {}
  if (err && this.socket._nocb) { /* noop */ }
};

/** 连接并做 SMTP 对话；返回一个可用的 session（已 EHLO） */
async function connect(cfg) {
  const opts = {
    host: cfg.host,
    port: cfg.port,
    connectTimeout: cfg.connectTimeout,
  };
  let socket;
  if (cfg.secure === 'tls') {
    socket = tls.connect(cfg.port, cfg.host, { rejectUnauthorized: false });
  } else {
    socket = net.connect(cfg.port, cfg.host);
  }
  const sess = new SmtpSession(socket);
  // 等待 220 欢迎
  const hello = await Promise.race([sess.read(cfg.connectTimeout), connectFail(socket)]);
  if (hello.code !== 220) throw new Error('SMTP 欢迎失败: ' + hello.line);

  // EHLO
  await sess.write('EHLO node-chat');
  const ehlo = await sess.read(cfg.connectTimeout);
  if (ehlo.code !== 250) throw new Error('EHLO 失败: ' + ehlo.line);
  const caps = ehlo.line.toUpperCase();

  // STARTTLS 升级
  if (cfg.secure === 'starttls') {
    if (!caps.includes('STARTTLS')) throw new Error('服务器不支持 STARTTLS');
    await sess.write('STARTTLS');
    const st = await sess.read(cfg.connectTimeout);
    if (st.code !== 220) throw new Error('STARTTLS 失败: ' + st.line);
    socket = tls.connect({ socket, rejectUnauthorized: false });
    // 重建会话（TLS 升级后重新包装）
    const sess2 = new SmtpSession(socket);
    await sess2.write('EHLO node-chat');
    const ehlo2 = await sess2.read(cfg.connectTimeout);
    if (ehlo2.code !== 250) throw new Error('STARTTLS 后 EHLO 失败: ' + ehlo2.line);
    return { session: sess2, socket };
  }

  // AUTH LOGIN
  if (cfg.user) {
    await sess.write('AUTH LOGIN');
    const a1 = await sess.read(cfg.connectTimeout);
    if (a1.code === 334) {
      await sess.write(Buffer.from(cfg.user).toString('base64'));
      const a2 = await sess.read(cfg.connectTimeout);
      if (a2.code === 334) {
        await sess.write(Buffer.from(cfg.pass || '').toString('base64'));
        const a3 = await sess.read(cfg.connectTimeout);
        if (a3.code !== 235) throw new Error('AUTH LOGIN 失败: ' + a3.line);
      }
    }
  }
  return { session: sess, socket };
}

function connectFail(socket) {
  return new Promise((_, reject) => {
    socket.once('error', (e) => reject(e));
  });
}

/** 发送一封邮件 */
async function send(cfg, { from, to, subject, text }) {
  const { session, socket } = await connect(cfg);
  try {
    await session.write('MAIL FROM:<' + (from || cfg.from) + '>');
    let r = await session.read(cfg.connectTimeout);
    if (r.code !== 250) throw new Error('MAIL FROM 失败: ' + r.line);

    await session.write('RCPT TO:<' + to + '>');
    r = await session.read(cfg.connectTimeout);
    if (r.code !== 250 && r.code !== 251) throw new Error('RCPT TO 失败: ' + r.line);

    await session.write('DATA');
    r = await session.read(cfg.connectTimeout);
    if (r.code !== 354) throw new Error('DATA 失败: ' + r.line);

    const headers =
      'From: ' + (from || cfg.from) + CRLF +
      'To: ' + to + CRLF +
      'Subject: ' + subject + CRLF +
      'MIME-Version: 1.0' + CRLF +
      'Content-Type: text/plain; charset=utf-8' + CRLF +
      'Content-Transfer-Encoding: 8bit' + CRLF +
      CRLF;
    // 转义行首的点
    const body = text.replace(/^\./gm, '..');
    await session.write(headers + body);
    await session.write('.');
    r = await session.read(cfg.connectTimeout);
    if (r.code !== 250) throw new Error('DATA 内容失败: ' + r.line);
  } finally {
    try { socket.end(); } catch (_) {}
  }
}

/** 组装验证码邮件正文（纯文本） */
function buildCodeMail({ email, username, code, ttlMin }) {
  return {
    to: email,
    subject: `Node Chat 邮箱验证码: ${code}`,
    text:
      '【Node Chat】\n\n' +
      '你的注册验证码是：' + code + '\n' +
      '（用户名：' + username + '）\n\n' +
      '验证码 ' + ttlMin + ' 分钟内有效，请勿泄露。\n' +
      '如果不是你本人操作，请忽略本邮件。',
  };
}

/**
 * 对外主入口：发验证码。
 * 返回 { ok:true } 表示已通过 SMTP 发出。
 * 未配置 SMTP 时降级：返回 { ok:true, devMode:true, code }，验证码由调用方打印到日志。
 */
async function sendVerifyCode({ email, username, code }, opts = {}) {
  const cfg = resolveConfig(opts);
  const ttlMin = Math.round((opts.ttlMs || 10 * 60 * 1000) / 60000);
  if (!isConfigured(cfg)) {
    return { ok: true, devMode: true, code, note: '未配置 SMTP，验证码走服务端日志降级' };
  }
  const mail = buildCodeMail({ email, username, code, ttlMin });
  await send(cfg, { from: cfg.from, to: mail.to, subject: mail.subject, text: mail.text });
  return { ok: true, devMode: false };
}

module.exports = {
  resolveConfig,
  isConfigured,
  sendVerifyCode,
  send,
  _internal: { connect, SmtpSession, buildCodeMail },
};