'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const P = require('./protocol');
const { C2S, S2C, ERR } = P;

/**
 * 可编程客户端库。
 * 命令行工具（cli.js / repl.js）以及你自己的脚本都可以直接复用它。
 *
 *   const { connect } = require('./client-lib');
 *   const c = await connect({ username: 'alice', password: '123456' });
 *   c.on('message', (m) => console.log('私聊:', m.from, m.text));
 *   await c.sendTo('bob', '在吗');
 *   await c.sendToRoom('general', '大家好');
 */
class ChatClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port === undefined ? 9099 : options.port;
    this.username = options.username || options.user || null;
    this.password = options.password || '';
    this.autoAuth = options.autoAuth !== false;
    this.timeout = options.timeout || 10000;
    this.received = { messages: [], groups: [], systems: [], presences: [] };

    this.socket = null;
    this.parser = new P.LineParser();
    // 跨分块保留 UTF-8 状态，避免中文在分块边界被截断成乱码
    this.decoder = new StringDecoder('utf8');
    this._pending = new Map();
    this._seq = 0;
    this._closed = false;
    this._heartbeat = null;
    this.lastError = null;

    // 允许在连接建立前注册回调，避免登录瞬间到达的消息被漏掉
    if (options.handlers) {
      for (const [event, fn] of Object.entries(options.handlers)) {
        if (typeof fn === 'function') this.on(event, fn);
      }
    }
  }

  /** 安全地抛出 error 事件：没有监听器时不会导致进程崩溃 */
  _emitError(err) {
    this.lastError = err;
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  /** 建立连接并（可选）完成认证 */
  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);

      const onError = (err) => {
        cleanup();
        socket.destroy();
        reject(err);
      };
      const cleanup = () => {
        socket.removeListener('error', onError);
        socket.removeListener('connect', onConnect);
      };
      const onConnect = () => {
        cleanup();
        this._startHeartbeat();
        this.emit('connect');
        if (!this.autoAuth) return resolve(this);
        this._authenticate()
          .then(() => resolve(this))
          .catch((err) => {
            socket.destroy();
            reject(err);
          });
      };

      socket.once('error', onError);
      socket.once('connect', onConnect);

      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => {
        this._closed = true;
        this._stopHeartbeat();
        for (const [, p] of this._pending) p.reject(new Error('连接已关闭'));
        this._pending.clear();
        this.emit('close');
      });
      socket.on('error', (err) => this._emitError(err));
    });
  }

  _authenticate() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('认证超时')), this.timeout);
      this.once('auth_ok', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.once('auth_err', (data) => {
        clearTimeout(timer);
        reject(new Error(data.message || '认证失败'));
      });
      this._write(C2S.AUTH, { username: this.username, password: this.password });
    });
  }

  _startHeartbeat() {
    this._heartbeat = setInterval(() => {
      if (!this._closed) this._write(C2S.PING, {});
    }, 30000);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  _write(type, data, id) {
    if (!this.socket || this.socket.destroyed) throw new Error('连接不可用');
    this.socket.write(P.encode(P.frame(type, data, id)));
  }

  _onData(chunk) {
    let frames = [];
    try {
      frames = this.parser.push(this.decoder.write(chunk));
    } catch (err) {
      // 已解析成功的帧不丢
      if (Array.isArray(err.frames)) frames = err.frames;
      this._emitError(err);
    }
    for (const frame of frames) this._onFrame(frame);
  }

  _onFrame(frame) {
    this.emit('raw', frame);
    const { type, data = {}, id } = frame;

    // 先处理与请求 id 配对的响应
    if (id && this._pending.has(id)) {
      const pending = this._pending.get(id);
      this._pending.delete(id);
      clearTimeout(pending.timer);
      if (type === S2C.ACK && data.ok === false) {
        pending.reject(new Error(data.message || '操作失败'));
      } else if (type === S2C.ERROR) {
        pending.reject(new Error(data.message || data.code || '服务端错误'));
      } else {
        pending.resolve(data);
      }
      return;
    }

    switch (type) {
      case S2C.AUTH_OK:
        this.emit('auth_ok', data);
        return;
      case S2C.AUTH_ERR:
        this.emit('auth_err', data);
        return;
      case S2C.MSG:
        this.received.messages.push(data);
        this.emit('message', data);
        this.emit('incoming', data);
        return;
      case S2C.GROUP:
        this.received.groups.push(data);
        this.emit('group', data);
        this.emit('incoming', data);
        return;
      case S2C.SYSTEM:
        this.received.systems.push(data);
        this.emit('system', data);
        if (data && data.event === 'avatar') {
          this.emit('avatar', data);
          this.emit('incoming', data); // 头像变更也算入站事件，便于 waitFor
        }
        return;
      case S2C.PROFILE:
        this.emit('profile', data);
        return;
      case S2C.PRESENCE:
        this.received.presences.push(data);
        this.emit('presence', data);
        this.emit('incoming', data);
        return;
      case S2C.ACK:
        this.emit('ack', data);
        return;
      case S2C.ERROR:
        this._emitError(new Error(data.message || data.code || '服务端错误'));
        return;
      case S2C.PONG:
        this.emit('pong', data);
        return;
      default:
        this.emit('unknown', frame);
    }
  }

  /** 发送一条请求并等待服务端应答 */
  _request(type, data, timeout = this.timeout) {
    const id = `r${++this._seq}_${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`请求超时: ${type}`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._write(type, data, id);
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ------------------------------------------------------------------ API
  /** 发送私聊（text 与 image 至少给一个，image 为 data URL） */
  sendTo(to, text, image) {
    const data = { to, text: text || '' };
    if (image) data.image = image;
    return this._request(C2S.MSG, data);
  }

  /** 发送群消息（需已加入该群，image 为 data URL） */
  sendToRoom(room, text, image) {
    const data = { room, text: text || '' };
    if (image) data.image = image;
    return this._request(C2S.GROUP, data);
  }

  /** 设置自己的头像（data URL） */
  setAvatar(dataUrl) {
    return this._request(C2S.PROFILE, { action: 'set', avatar: dataUrl });
  }

  /** 查询某个用户的头像 */
  getAvatar(user) {
    return this._request(C2S.PROFILE, { action: 'get', user });
  }

  /** 加入群（群不存在会自动创建） */
  joinRoom(room) {
    return this._request(C2S.JOIN, { room });
  }

  /** 退出群 */
  leaveRoom(room) {
    return this._request(C2S.LEAVE, { room });
  }

  /** 列出所有群 */
  listRooms() {
    return this._request(C2S.ROOMS, {});
  }

  /** 查询群成员 */
  listMembers(room) {
    return this._request(C2S.MEMBERS, { room });
  }

  /** 在线用户列表 */
  who() {
    return this._request(C2S.WHO, {});
  }

  /** 历史消息：{ room } 或 { to } */
  history(scope = {}) {
    return this._request(C2S.HISTORY, scope);
  }

  /**
   * 等待某个满足条件的消息到达（脚本里很有用）。
   * 会先回溯已收到的缓冲区，避免「消息比监听先到」导致丢失。
   */
  waitFor(predicate, timeout = this.timeout) {
    const buffered = [
      ...this.received.messages,
      ...this.received.groups,
      ...this.received.presences,
    ];
    const hit = buffered.find((m) => predicate(m));
    if (hit) return Promise.resolve(hit);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('incoming', onMsg);
        reject(new Error('等待消息超时'));
      }, timeout);
      const onMsg = (msg) => {
        if (!predicate(msg)) return;
        clearTimeout(timer);
        this.off('incoming', onMsg);
        resolve(msg);
      };
      this.on('incoming', onMsg);
    });
  }

  close() {
    this._stopHeartbeat();
    if (this.socket && !this.socket.destroyed) {
      try {
        this._write(C2S.QUIT, {});
      } catch (_) {}
      this.socket.end();
    }
  }
}

/** 连接并返回已认证的客户端 */
async function connect(options = {}) {
  const client = new ChatClient(options);
  await client.connect();
  return client;
}

/** 把本地图片文件转成 data URL（便于直接作为 image 字段发送） */
function fileToDataUrl(filePath) {
  const fs = require('fs');
  const path = require('path');
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
    }[ext] || 'image/jpeg';
  const buf = fs.readFileSync(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

module.exports = { ChatClient, connect, fileToDataUrl, ERR };
