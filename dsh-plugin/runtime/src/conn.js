'use strict';

/**
 * 最小 NDJSON 客户端 —— 与 node-chat 服务端同协议，零依赖。
 *
 * 只做四件事：连接、认证、请求/响应、事件回调。
 * 重连由 daemon 决定策略，这里只负责「断了告诉你」和「保活」。
 */

const net = require('net');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const SB = require('./secure');

/** 服务端在 5 分钟无数据时踢人，所以保活必须小于这个值 */
const DEFAULT_KEEPALIVE_MS = 120 * 1000;
const MAX_LINE = 1024 * 1024;

class ChatConn extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port;
    this.user = opts.user;
    this.pass = opts.pass;
    this.keepAliveMs = opts.keepAliveMs || DEFAULT_KEEPALIVE_MS;
    /** 是否走应用层加密；服务端同时支持明文与加密 */
    this.secure = !!opts.secure;
    /** 服务端指纹记录文件；false 表示不落盘 */
    this.pinFile = opts.pinFile;
    this.crypto = null;
    this.fingerprint = null;

    this._socket = null;
    this._decoder = null;
    this._buf = '';
    this._seq = 0;
    this._waiting = new Map();
    this._pingTimer = null;
    this._destroyed = false;
    this.lastRxAt = 0;
    this.authInfo = null;
  }

  connect(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this._socket = socket;
      this._decoder = new StringDecoder('utf8');
      this._buf = '';
      socket.setNoDelay(true);

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error('连接超时：' + this.host + ':' + this.port));
      }, timeoutMs);

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      socket.once('connect', async () => {
        try {
          // 先协商加密，再认证——密码因此不会以明文过网
          if (this.secure) await this._secure();
          const info = await this._auth();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.authInfo = info;
          this._startKeepAlive();
          resolve(info);
        } catch (err) {
          fail(err);
        }
      });

      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => {
        if (!settled) fail(err);
        else this.emit('socketError', err);
      });
      socket.on('close', () => this._onClose());
    });
  }

  _auth() {
    return this._request('auth', { username: this.user, password: this.pass }, {
      expectType: 'auth_ok',
      timeoutMs: 10000,
      // 认证失败服务端回 auth_err，需要单独识别
      errorTypes: { auth_err: 'auth_failed' },
    });
  }

  /** 加密握手（TOFU：首次记指纹，之后不一致就拒绝连接） */
  async _secure() {
    const keys = SB.newX25519();
    const pubRaw = SB.rawPublicKey(keys.publicKey);
    const data = await this._request('secure', { v: SB.SECURE_VERSION, cpub: SB.b64(pubRaw) }, {
      expectType: 'secure_ok',
      errorTypes: { secure_err: 'secure_rejected' },
      timeoutMs: 10000,
    });
    const pins = this.pinFile === false ? null : new SB.PinStore(this.pinFile);
    const pinned = pins ? pins.get(this.host, this.port) : null;
    const result = SB.finishHandshake(data, keys, pubRaw, pinned);
    if (pins && !pinned) {
      try {
        pins.set(this.host, this.port, result.fp);
      } catch (writeErr) {
        // 记不住指纹不影响本次连接（签名已校验），但必须让守护日志看见
        this.pinWarning = writeErr.message;
        this.emit('pinWarning', writeErr);
      }
    }
    this.crypto = result.channel;
    this.fingerprint = result.fp;
    this.emit('secure', { fp: result.fp, pinned: !!pinned });
  }

  _onData(chunk) {
    this.lastRxAt = Date.now();
    this._buf += this._decoder.write(chunk);
    if (this._buf.length > MAX_LINE * 4) {
      // 防御：脏数据导致缓冲无限增长
      this._buf = '';
      this.emit('protocolError', new Error('接收缓冲溢出'));
      return;
    }
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (this.crypto) {
        try {
          frame = this.crypto.open(frame);
        } catch (e) {
          this.emit('protocolError', e);
          if (this._socket) this._socket.destroy();
          return;
        }
      }
      this._dispatch(frame);
    }
  }

  _dispatch(frame) {
    const type = String(frame.type || '');

    // 1) 有 id 的响应
    if (frame.id && this._waiting.has(frame.id)) {
      const w = this._waiting.get(frame.id);
      this._waiting.delete(frame.id);
      clearTimeout(w.timer);
      if (type === 'error') {
        const d = frame.data || {};
        const err = new Error(d.message || '服务端错误');
        err.code = d.code;
        return w.reject(err);
      }
      if (type === 'secure_err') {
        const d = frame.data || {};
        const err = new Error(d.message || '服务端拒绝加密握手');
        err.code = d.code || 'secure_rejected';
        return w.reject(err);
      }
      return w.resolve(frame.data || {});
    }

    // 2) 无 id 的响应（pong 等）：按类型匹配最早的等待者
    for (const [id, w] of this._waiting) {
      if (w.expectType === type || (w.errorTypes && w.errorTypes[type])) {
        this._waiting.delete(id);
        clearTimeout(w.timer);
        if (w.errorTypes && w.errorTypes[type]) {
          const d = frame.data || {};
          const err = new Error(d.message || '认证失败');
          err.code = w.errorTypes[type];
          return w.reject(err);
        }
        return w.resolve(frame.data || {});
      }
    }

    // 3) 服务器推送
    if (type === 'msg' || type === 'group') return this.emit('message', frame.data || {}, type);
    if (type === 'system' || type === 'presence') return this.emit('notice', frame.data || {}, type);
    // pong 落这里，刷新 lastRxAt 就够了
  }

  _request(type, data, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      if (!this._socket || this._socket.destroyed) return reject(new Error('连接已断开'));
      const id = 'q' + ++this._seq + '_' + Date.now().toString(36);
      const timer = setTimeout(() => {
        this._waiting.delete(id);
        reject(new Error(type + ' 超时（' + (opts.timeoutMs || 15000) + 'ms）'));
      }, opts.timeoutMs || 15000);
      this._waiting.set(id, {
        id,
        expectType: opts.expectType,
        errorTypes: opts.errorTypes,
        resolve,
        reject,
        timer,
      });
      this._write({ type, data: data || {}, id });
    });
  }

  /** 有响应的请求 */
  request(type, data, opts) {
    return this._request(type, data, opts);
  }

  /** 单向发送（不需要响应） */
  send(type, data) {
    this._write({ type, data: data || {} });
  }

  _write(frame) {
    const socket = this._socket;
    if (!socket || socket.destroyed) throw new Error('连接已断开');
    const out = this.crypto ? this.crypto.seal(frame) : frame;
    socket.write(JSON.stringify(out) + '\n');
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    this._pingTimer = setInterval(() => {
      try {
        this.send('ping', {});
      } catch (e) {
        /* close 事件会处理 */
      }
    }, this.keepAliveMs);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  _stopKeepAlive() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _onClose() {
    this._stopKeepAlive();
    for (const [, w] of this._waiting) {
      clearTimeout(w.timer);
      w.reject(new Error('连接已断开'));
    }
    this._waiting.clear();
    if (!this._destroyed) this.emit('close');
  }

  close() {
    this._destroyed = true;
    this._stopKeepAlive();
    if (this._socket) {
      try {
        this._socket.end();
      } catch (e) {
        /* ignore */
      }
      setTimeout(() => {
        try {
          this._socket.destroy();
        } catch (e) {
          /* ignore */
        }
      }, 300).unref();
    }
  }
}

module.exports = ChatConn;
