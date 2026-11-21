'use strict';

/**
 * agentbus daemon —— 这条链路上唯一持有 TCP 连接的进程。
 *
 * 职责边界（越界就会变成两类 bug：要么抢连接，要么丢消息）：
 *   · 持有连接、保活、重连、历史补投
 *   · 收信 → 按 policy 判定「唤醒 / 只落盘」→ 写 ledger
 *   · 在 127.0.0.1:9101 上给 watchdog 和 agent 提供本地接口
 *
 * 它不做业务判断，也不知道 agent 在干什么。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ChatConn = require('./conn');
const Store = require('./store');

const DEFAULT_REDELIVER_MS = 5 * 60 * 1000;

// ------------------------------------------------------------------ 配置

function loadConfig(p) {
  const file = path.resolve(p || 'config.json');
  if (!fs.existsSync(file)) {
    console.error('找不到配置文件：' + file);
    console.error('先复制一份：cp config.example.json config.json');
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.host = cfg.host || '127.0.0.1';
  cfg.port = cfg.port || 9099;
  cfg.rooms = Array.isArray(cfg.rooms) ? cfg.rooms : [];
  /** 传输加密：默认关，服务端同时支持明文与加密 */
  cfg.secure = !!cfg.secure;
  cfg.dataDir = path.resolve(path.dirname(file), cfg.dataDir || './data');
  cfg.wake = Object.assign({ dm: true, mention: true }, cfg.wake || {});
  cfg.http = Object.assign({ host: '127.0.0.1', port: 9101 }, cfg.http || {});
  cfg.redeliverMs = cfg.redeliverMs || DEFAULT_REDELIVER_MS;
  cfg.keepAliveMs = cfg.keepAliveMs || 120 * 1000;
  if (!cfg.user || !cfg.pass) {
    console.error('配置里必须有 user / pass');
    process.exit(2);
  }
  return cfg;
}

// ------------------------------------------------------------------ 唤醒判定

const ASCII_WORD = /[A-Za-z0-9_-]/;

/**
 * 文本里是否 @ 了指定名字。
 * 只对 ASCII 名字做边界检查，中文名字后面跟汉字也算命中（否则「@张三你好」识别不出来）。
 */
function mentions(text, name) {
  if (!text || !name) return false;
  const needle = '@' + name;
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i < 0) return false;
    const after = text.charAt(i + needle.length);
    if (!after || !ASCII_WORD.test(after)) return true;
    from = i + 1;
  }
}

// ------------------------------------------------------------------ 主体

class Daemon {
  constructor(cfg) {
    this.cfg = cfg;
    this.store = new Store(cfg.dataDir);
    this.conn = null;
    this.waiters = new Set();
    this.startedAt = Date.now();
    this.connected = false;
    this._backoff = 1000;
    this._token = '';
    this._http = null;
    this.logPath = path.join(cfg.dataDir, 'daemon.log');
  }

  log(msg) {
    const line = '[' + new Date().toISOString() + '] ' + msg;
    console.log(line);
    try {
      fs.appendFileSync(this.logPath, line + '\n');
    } catch (e) {
      /* 日志失败不影响主流程 */
    }
  }

  // ---------------------------------------------------------------- 启动

  start() {
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });

    // 单例：pid 还活着就不许第二个起来
    const pidFile = path.join(this.cfg.dataDir, 'daemon.pid');
    if (fs.existsSync(pidFile)) {
      const old = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      if (old && old !== process.pid && alive(old)) {
        console.error('已有实例在跑（pid ' + old + '），退出');
        process.exit(3);
      }
    }
    fs.writeFileSync(pidFile, String(process.pid));

    this._token = this._loadToken();
    this.store.load();

    // 首次启动：水位定在「现在」，只从这一刻开始收新消息。
    // 否则会把服务端历史里的老消息全部当成「刚收到」灌给 agent。
    if (this.store.fresh && !this.cfg.backfillHistory) {
      this.store.state.cursorTs = Date.now();
      this.store.saveState();
      this.log('首次启动，水位定在现在（不回放历史；要回放把 backfillHistory 设为 true）');
    }
    this.log(
      '启动 · user=' + this.cfg.user + ' · server=' + this.cfg.host + ':' + this.cfg.port +
        ' · rooms=' + JSON.stringify(this.cfg.rooms) + ' · cursor=' + this.store.state.cursorTs +
        ' · 加密=' + (this.cfg.secure ? '开' : '关')
    );

    this._startHttp();
    this._connect();

    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
    process.on('exit', () => {
      try {
        fs.unlinkSync(pidFile);
      } catch (e) {
        /* ignore */
      }
    });
  }

  _loadToken() {
    const p = path.join(this.cfg.dataDir, 'token');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    const t = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(p, t, { mode: 0o600 });
    return t;
  }

  // ---------------------------------------------------------------- 连接

  _connect() {
    this.conn = new ChatConn({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      pass: this.cfg.pass,
      keepAliveMs: this.cfg.keepAliveMs,
      secure: this.cfg.secure,
      // 指纹记录放在 data 目录，跟 token 同级，便于整目录搬迁
      pinFile: path.join(this.cfg.dataDir, 'known-servers.json'),
    });

    this.conn.on('message', (msg, type) => this._ingest(msg, type));
    this.conn.on('secure', (info) => {
      this.log('加密已启用 · 服务端指纹 ' + info.fp + (info.pinned ? '（与记录一致）' : '（首次信任，已记住）'));
    });
    this.conn.on('pinWarning', (e) => this.log('【警告】' + e.message));
    this.conn.on('notice', (d) => {
      if (d && d.event) this.log('系统事件 · ' + d.event + (d.user ? ' · ' + d.user : ''));
    });
    this.conn.on('close', () => {
      this.connected = false;
      this.log('连接断开，' + Math.round(this._backoff / 1000) + ' 秒后重连');
      setTimeout(() => this._connect(), this._backoff);
      this._backoff = Math.min(this._backoff * 2, 30000);
      if (this._backoff > 30000) this._backoff = 30000;
    });

    this.conn
      .connect()
      .then(() => this.connected = true)
      .then(() => this._afterReady())
      .catch((err) => {
        this.log('连不上：' + err.message + '，' + Math.round(this._backoff / 1000) + ' 秒后重试');
        setTimeout(() => this._connect(), this._backoff);
        this._backoff = Math.min(this._backoff * 2, 30000);
      });
  }

  async _afterReady() {
    this._backoff = 1000;
    this.connected = true;
    this.log('已登录为 ' + this.cfg.user);

    for (const room of this.cfg.rooms) {
      try {
        await this.conn.request('join', { room }, { expectType: 'join_ok', timeoutMs: 8000 });
        this.log('已在群「' + room + '」');
      } catch (e) {
        this.log('加入群「' + room + '」失败：' + e.message);
      }
    }

    await this._backfill();
  }

  /** 断线期间的空窗：用历史补，按 ts 过滤 + id 去重，两条保险都不省 */
  async _backfill() {
    const since = Math.max(0, this.store.state.cursorTs - 1000);
    let recovered = 0;
    for (const room of this.cfg.rooms) {
      try {
        const d = await this.conn.request(
          'history',
          { room, limit: this.cfg.backfillLimit || 50 },
          { expectType: 'history', timeoutMs: 10000 }
        );
        const msgs = (d && d.messages) || [];
        for (const m of msgs) {
          if (m.ts <= since) continue;
          if (this._ingest(Object.assign({ room: room }, m), 'group')) recovered++;
        }
      } catch (e) {
        this.log('补历史失败（' + room + '）：' + e.message);
      }
    }
    if (recovered) this.log('补回 ' + recovered + ' 条空窗消息');
    this.store.saveState();
  }

  // ---------------------------------------------------------------- 收信

  _ingest(msg, kind) {
    if (!msg || !msg.id) return false;
    if (msg.from === this.cfg.user) return false;

    const wake = this._isWake(msg, kind);
    const entry = {
      id: msg.id,
      kind: kind === 'msg' ? 'dm' : 'group',
      from: msg.from || '',
      to: msg.to,
      room: msg.room,
      text: msg.text || '',
      hasImage: !!msg.image,
      image: msg.image && msg.image.length < 200000 ? msg.image : undefined,
      offline: !!msg.offline,
      ts: msg.ts || Date.now(),
      wake: wake,
      // 只落盘的消息不进 pending 队列，避免 agent 每次醒来都被群聊噪声刷一遍
      status: wake ? 'pending' : 'archived',
      ingestedAt: Date.now(),
    };

    const fresh = this.store.add(entry);
    if (!fresh) return false;

    this.log(
      (wake ? '【唤醒】' : '落盘 · ') + entry.from + ' → ' + (entry.room || entry.to) +
        ' · ' + String(entry.text).replace(/\s+/g, ' ').slice(0, 60)
    );

    if (wake) this._feedWaiters();
    return true;
  }

  _isWake(msg, kind) {
    if (kind === 'msg') return this.cfg.wake.dm !== false;
    return this.cfg.wake.mention !== false && mentions(msg.text, this.cfg.user);
  }

  // ---------------------------------------------------------------- 长轮询

  _feedWaiters() {
    for (const w of Array.from(this.waiters)) {
      const list = this.store.pickDeliverable(this.cfg.redeliverMs, w.sinceTs);
      if (!list.length) continue;
      this.waiters.delete(w);
      clearTimeout(w.timer);
      this._deliver(w.res, list);
    }
  }

  _deliver(res, list) {
    const ids = list.map((e) => e.id);
    this.store.markDelivered(ids);
    const backlog = this.store.backlog(this.store.state.backlogSeenTs, 5);
    this.store.state.backlogSeenTs = Date.now();
    this.store.state.lastWakeAt = Date.now();
    this.store.saveState();
    sendJson(res, 200, {
      ok: true,
      wake: list,
      backlog: backlog,
      cursor: this.store.state.cursorTs,
    });
  }

  // ---------------------------------------------------------------- HTTP

  _startHttp() {
    this._http = http.createServer((req, res) => this._route(req, res));
    this._http.on('error', (err) => {
      this.log('HTTP 端口不可用：' + err.message);
      process.exit(1);
    });
    this._http.listen(this.cfg.http.port, this.cfg.http.host, () => {
      this.log('本地接口 http://' + this.cfg.http.host + ':' + this.cfg.http.port + ' （token 在 data/token）');
    });
  }

  _route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/health') return sendJson(res, 200, { ok: true, up: Date.now() - this.startedAt });

    if (req.headers['x-agentbus-token'] !== this._token) {
      return sendJson(res, 401, { ok: false, error: 'token 无效' });
    }

    if (req.method === 'GET' && p === '/status') {
      return sendJson(res, 200, {
        ok: true,
        connected: this.connected,
        user: this.cfg.user,
        server: this.cfg.host + ':' + this.cfg.port,
        rooms: this.cfg.rooms,
        pending: this.store.pendingList().length,
        cursor: this.store.state.cursorTs,
        waiters: this.waiters.size,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      });
    }

    if (req.method === 'GET' && p === '/pending') {
      const list = this.store.pendingList();
      return sendJson(res, 200, {
        ok: true,
        count: list.length,
        messages: list,
        backlog: this.store.backlog(this.store.state.backlogSeenTs, 10),
      });
    }

    if (req.method === 'GET' && p === '/inbox/next') {
      const wait = Math.min(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 600);
      const sinceTs = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      const list = this.store.pickDeliverable(this.cfg.redeliverMs, sinceTs);
      if (list.length) return this._deliver(res, list);
      if (!wait) return sendJson(res, 200, { ok: true, wake: [], timeout: true });

      const timer = setTimeout(() => {
        this.waiters.delete(w);
        sendJson(res, 200, {
          ok: true,
          wake: [],
          timeout: true,
          backlog: this.store.backlog(this.store.state.backlogSeenTs, 5),
          cursor: this.store.state.cursorTs,
        });
      }, wait * 1000);
      const w = { res, sinceTs, timer };
      this.waiters.add(w);
      req.on('close', () => {
        if (this.waiters.has(w)) {
          this.waiters.delete(w);
          clearTimeout(timer);
        }
      });
      return;
    }

    if (req.method === 'POST') {
      return readBody(req, (body) => this._handlePost(p, body, res));
    }

    sendJson(res, 404, { ok: false, error: '未知接口 ' + p });
  }

  _handlePost(p, body, res) {
    if (p === '/ack') {
      const ids = body.ids || (body.id ? [body.id] : []);
      if (!ids.length) return sendJson(res, 400, { ok: false, error: '缺少 id' });
      const updated = [];
      for (const id of ids) {
        const e = this.store.setStatus(id, 'acked', { ackedAt: Date.now() });
        if (e) updated.push(id);
      }
      this.store.saveState();
      return sendJson(res, 200, { ok: true, acked: updated, missing: ids.filter((i) => !updated.includes(i)) });
    }

    if (p === '/reply') {
      const id = body.id;
      const text = String(body.text || '');
      const e = this.store.get(id);
      if (!e) return sendJson(res, 404, { ok: false, error: '没有这条消息：' + id });
      if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'text 不能为空' });

      // 私聊回给发信人（e.from），不是 e.to——e.to 是「我」自己，会撞「不能给自己发私聊」
      const isDm = e.kind === 'dm' || (!e.room && e.to);
      const payload = isDm ? { room: null, to: e.from, text: text } : { room: e.room, to: null, text: text };
      return this._outbound(payload, (err, ack) => {
        if (err) return sendJson(res, 502, { ok: false, error: err.message });
        this.store.setStatus(id, 'done', { repliedAt: Date.now() });
        sendJson(res, 200, { ok: true, id: id, sent: ack });
      });
    }

    if (p === '/send') {
      const text = String(body.text || '');
      if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'text 不能为空' });
      if (!body.room && !body.to) return sendJson(res, 400, { ok: false, error: '需要 room 或 to' });
      return this._outbound({ room: body.room, to: body.to, text: text, image: body.image }, (err, ack) => {
        if (err) return sendJson(res, 502, { ok: false, error: err.message });
        sendJson(res, 200, { ok: true, sent: ack });
      });
    }

    sendJson(res, 404, { ok: false, error: '未知接口 ' + p });
  }

  _outbound(payload, cb) {
    if (!this.conn || !this.connected) return cb(new Error('守护进程当前未连接服务端'));
    const isRoom = !!payload.room;
    const type = isRoom ? 'group' : 'msg';
    const data = isRoom
      ? { room: payload.room, text: payload.text }
      : { to: payload.to, text: payload.text };
    if (payload.image) data.image = payload.image;

    this.conn
      .request(type, data, { expectType: 'ack', timeoutMs: 15000 })
      .then((d) => cb(null, d))
      .catch((err) => cb(err));
  }

  stop() {
    this.log('收到退出信号，保存状态');
    this.store.saveState();
    if (this.conn) this.conn.close();
    if (this._http) this._http.close();
    setTimeout(() => process.exit(0), 200);
  }
}

// ------------------------------------------------------------------ 工具

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, cb) {
  let buf = '';
  req.on('data', (c) => {
    buf += c;
    if (buf.length > 2 * 1024 * 1024) req.destroy();
  });
  req.on('end', () => {
    try {
      cb(buf ? JSON.parse(buf) : {});
    } catch (e) {
      cb({});
    }
  });
}

// ------------------------------------------------------------------ 入口

if (require.main === module) {
  const argIdx = process.argv.indexOf('--config');
  const cfgPath = argIdx > 0 ? process.argv[argIdx + 1] : 'config.json';
  const daemon = new Daemon(loadConfig(cfgPath));
  daemon.start();
}

module.exports = { Daemon, loadConfig, mentions };
