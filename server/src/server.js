'use strict';

const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { StringDecoder } = require('string_decoder');

const P = require('./protocol');
const { Store } = require('./store');
const S = require('./secure');
const Mailer = require('./mailer');

const { C2S, S2C, ERR, LIMITS } = P;

const SYSTEM_USER = '系统';

/** 单个客户端连接 */
class Session {
  constructor(socket, id) {
    this.id = id;
    this.socket = socket;
    this.parser = new P.LineParser();
    // 跨分块保留 UTF-8 状态，避免中文在分块边界被截断成乱码
    this.decoder = new StringDecoder('utf8');
    this.user = null; // 认证后的用户名
    this.rooms = new Set(); // 已加入的群
    this.alive = true;
    this.lastActive = Date.now();
    this.rate = { count: 0, windowStart: Date.now() };
    /** 加密信道；null 表示这条连接还是明文 */
    this.crypto = null;
    this.fp = null; // 客户端看到的服务端指纹（握手成功时填）
  }

  get authenticated() {
    return this.user !== null;
  }

  /** 简单令牌桶：10 秒内最多 60 条业务消息 */
  allowRequest() {
    const now = Date.now();
    if (now - this.rate.windowStart > 10000) {
      this.rate = { count: 0, windowStart: now };
    }
    this.rate.count += 1;
    return this.rate.count <= 60;
  }
}

/**
 * 聊天服务端。
 * 既可作为命令行程序运行（node src/server.js），也可作为库被测试/嵌入调用：
 *   const srv = await createChatServer({ port: 0 });
 */
class ChatServer {
  constructor(options = {}) {
    this.host = options.host || '0.0.0.0';
    this.port = options.port === undefined ? 9099 : options.port;
    this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
    this.serverName = options.serverName || 'node-chat-server';
    this.demo = options.demo || false;
    /** 只接受加密连接（默认 true：强制加密，无明文，不向下兼容） */
    this.requireSecure = options.requireSecure === undefined ? true : !!options.requireSecure;
    /** 邮箱验证登录：注册需邮箱验证码（默认 true，本分支新版本不向下兼容） */
    this.requireEmailVerify = options.requireEmailVerify === undefined ? true : !!options.requireEmailVerify;
    /** SMTP 发信模块（零依赖，对象含 sendVerifyCode 等方法） */
    this.mailer = Mailer;
    this.smtp = options.smtp || {};
    this.store = new Store(this.dataDir);
    /** 服务端长期身份（Ed25519），启动时加载或生成 */
    this.identity = null;
    /** username -> Session */
    this.sessions = new Map();
    /** 所有连接（含未认证），停服时统一销毁 */
    this._sockets = new Set();
    /** username -> 离线期间积压的私聊消息 */
    this._pendingInbox = new Map();
    this._sessionSeq = 0;
    this._heartbeat = null;
    this._stdin = null;
  }

  // ------------------------------------------------------------------ 启停
  async start() {
    this.identity = S.loadOrCreateIdentity(this.dataDir);
    if (this.requireSecure) {
      process.stdout.write(`[secure] 只接受加密连接，服务端指纹 ${this.identity.fp}\n`);
    } else {
      process.stdout.write(`[secure] 加密可用（明文仍接受），服务端指纹 ${this.identity.fp}\n`);
    }
    this.store.load();
    if (this.demo) this._seedDemoUsers();

    this.server = net.createServer((socket) => this._onConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    this._startHeartbeat();
    return this;
  }

  async stop() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    this._stopStdin();
    for (const session of this.sessions.values()) {
      try {
        session.socket.destroy();
      } catch (_) {}
    }
    this.sessions.clear();
    for (const socket of this._sockets) {
      try {
        socket.destroy();
      } catch (_) {}
    }
    this._sockets.clear();
    this.store.close();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }

  _seedDemoUsers() {
    for (const name of ['alice', 'bob', 'carol']) {
      if (!this.store.hasUser(name)) {
        this.store.createUser(name, '123456', `${name}@demo.local`);
        // 演示账号直接视为已验证（方便本地体验 / 老测试）
        const u = this.store.users.get(name);
        u.verified = true;
        this.store._touch(this.store.usersFile);
      }
    }
    this.store.ensureRoom('general', '系统');
    this.store.ensureRoom('dev', '系统');
  }

  // ------------------------------------------------------------- 连接管理
  _onConnection(socket) {
    socket.setNoDelay(true);
    this._sockets.add(socket);
    const session = new Session(socket, ++this._sessionSeq);

    socket.on('data', (chunk) => {
      session.lastActive = Date.now();
      let messages = [];
      try {
        messages = session.parser.push(session.decoder.write(chunk));
      } catch (err) {
        // 已解析成功的帧不丢，继续处理；再把错误回给客户端
        if (Array.isArray(err.frames)) messages = err.frames;
        this._send(session, P.frame(S2C.ERROR, { code: err.code || 'bad_request', message: err.message }));
      }
      for (const raw of messages) {
        let msg = raw;
        if (session.crypto) {
          // 已经协商好加密之后，只认密文帧。明文一律视为降级攻击。
          try {
            msg = session.crypto.open(raw);
          } catch (e) {
            this._send(session, P.frame(S2C.ERROR, { code: e.code || 'decrypt_failed', message: e.message }));
            socket.destroy();
            return;
          }
        }
        if (this.requireSecure && !session.crypto && msg && msg.type !== C2S.SECURE) {
          this._send(
            session,
            P.frame(S2C.SECURE_ERR, {
              code: ERR.SECURE_REQUIRED,
              message: '本服务端要求加密连接，请先发送 secure 握手',
            })
          );
          socket.destroy();
          return;
        }
        try {
          this._dispatch(session, msg);
        } catch (err) {
          this._send(session, P.frame(S2C.ERROR, { code: ERR.INTERNAL, message: err.message }));
        }
      }
    });

    socket.on('error', () => {
      /* 忽略连接层错误，close 事件统一处理 */
    });

    socket.on('close', () => {
      this._sockets.delete(socket);
      this._onClose(session);
    });
  }

  _onClose(session) {
    if (!session.user) return;
    this.sessions.delete(session.user);
    this._broadcastPresence(session.user, false);
    this._sendToAll(
      P.frame(S2C.SYSTEM, { event: 'user_left', user: session.user, at: Date.now() }),
      session.user
    );
  }

  _startHeartbeat() {
    this._heartbeat = setInterval(() => {
      const now = Date.now();
      for (const session of this.sessions.values()) {
        if (now - session.lastActive > 5 * 60 * 1000) {
          session.socket.destroy();
          continue;
        }
        this._send(session, P.frame(S2C.PONG, { at: now }));
      }
    }, 15000);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  // ------------------------------------------------------------ 消息分发
  _dispatch(session, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      this._send(session, P.frame(S2C.ERROR, { code: ERR.BAD_REQUEST, message: '缺少 type 字段' }));
      return;
    }
    const data = msg.data || {};

    if (msg.type === C2S.SECURE) return this._handleSecure(session, data, msg.id);
    if (msg.type === C2S.AUTH) return this._handleAuth(session, data, msg.id);
    if (msg.type === C2S.REGISTER) return this._handleRegister(session, data, msg.id);
    if (msg.type === C2S.VERIFY_EMAIL) return this._handleVerifyEmail(session, data, msg.id);
    if (msg.type === C2S.RESEND_CODE) return this._handleResendCode(session, data, msg.id);
    if (msg.type === C2S.PING) return this._send(session, P.frame(S2C.PONG, { at: Date.now() }));

    if (!session.authenticated) {
      this._send(
        session,
        P.frame(S2C.ERROR, { code: ERR.UNAUTHORIZED, message: '请先认证（auth）' }, msg.id)
      );
      return;
    }
    if (!session.allowRequest()) {
      this._send(session, P.frame(S2C.ERROR, { code: ERR.RATE_LIMIT, message: '发送过于频繁，请稍后再试' }));
      return;
    }

    switch (msg.type) {
      case C2S.MSG:
        return this._handlePrivateMessage(session, data, msg.id);
      case C2S.GROUP:
        return this._handleGroupMessage(session, data, msg.id);
      case C2S.JOIN:
        return this._handleJoin(session, data, msg.id);
      case C2S.LEAVE:
        return this._handleLeave(session, data, msg.id);
      case C2S.ROOMS:
        return this._send(session, P.frame(S2C.ROOMS, { rooms: this.store.listRooms() }, msg.id));
      case C2S.MEMBERS:
        return this._handleMembers(session, data, msg.id);
      case C2S.WHO:
        return this._send(
          session,
          P.frame(
            S2C.WHO,
            { users: [...this.sessions.keys()].sort(), avatars: this.store.listAvatars() },
            msg.id
          )
        );
      case C2S.PROFILE:
        return this._handleProfile(session, data, msg.id);
      case C2S.HISTORY:
        return this._handleHistory(session, data, msg.id);
      case C2S.QUIT:
        session.socket.end();
        return;
      default:
        this._send(
          session,
          P.frame(S2C.ERROR, { code: ERR.BAD_REQUEST, message: `未知类型: ${msg.type}`, id: msg.id })
        );
    }
  }

  // ------------------------------------------------------------------ 认证
  /**
   * 加密握手。无状态、可重试：失败不主动断开，客户端可以再发一次 secure。
   * 应答必须在 channel 生效前明文发出，所以顺序是「先发 secure_ok，再装 channel」。
   */
  _handleSecure(session, data, id) {
    if (session.crypto) {
      this._send(session, P.frame(S2C.SECURE_ERR, { code: 'already_secure', message: '这条连接已经加密过了' }, id));
      return;
    }
    let result;
    try {
      result = S.acceptHandshake(this.identity, data || {});
    } catch (e) {
      this._send(
        session,
        P.frame(S2C.SECURE_ERR, { code: e.code || 'handshake_failed', message: e.message }, id)
      );
      return;
    }
    this._send(session, P.frame(S2C.SECURE_OK, result.reply, id));
    session.crypto = result.channel;
    session.fp = result.reply.fp;
    // 密文整帧 base64 后体积变大，换更宽松的行上限
    session.parser = new P.LineParser(LIMITS.MAX_LINE_SECURE);
    process.stdout.write(`[secure] #${session.id} 加密握手完成（fp ${session.fp}）\n`);
  }

  _handleAuth(session, data, id) {
    const username = data.username;
    const password = data.password;

    if (!P.isValidUsername(username) || typeof password !== 'string' || !password) {
      return this._authFail(session, '用户名或密码格式不正确', id);
    }
    if (!this.store.hasUser(username)) {
      // 邮箱验证模式下没有自动注册：账号需先走 register + 邮箱验证
      return this._authFail(session, '用户不存在，请先注册', id);
    }
    // 先校验密码，再判断是否重复登录，避免用错误密码探测在线状态
    if (!this.store.verifyUser(username, password)) {
      return this._authFail(session, '密码错误', id);
    }
    if (this.requireEmailVerify && this.store.isPending(username)) {
      return this._send(
        session,
        P.frame(S2C.AUTH_ERR, { code: 'not_verified', message: '账号尚未通过邮箱验证' }, id)
      );
      // 不关闭连接：客户端可继续发起 verify_email
    }
    if (this.sessions.has(username)) {
      return this._authFail(session, `用户 ${username} 已在别处登录`, id);
    }

    session.user = username;
    this.sessions.set(username, session);
    this._send(
      session,
      P.frame(
        S2C.AUTH_OK,
        {
          user: username,
          rooms: this.store.listRooms(),
          server: this.serverName,
          avatar: this.store.getAvatar(username),
        },
        id
      )
    );
    this._broadcastPresence(username, true);
    this._sendToAll(P.frame(S2C.SYSTEM, { event: 'user_joined', user: username, at: Date.now() }), username);

    // 投递离线期间积压的私聊（延后一拍，客户端有机会先挂上监听）
    setImmediate(() => this._flushInbox(session));
  }

  /** 认证失败：回错误并关闭连接 */
  _authFail(session, message, id) {
    this._send(session, P.frame(S2C.AUTH_ERR, { message }, id));
    session.socket.end();
  }

  /** 生成 6 位验证码 */
  _genCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  /** 通过 SMTP（或日志降级）发送验证码邮件 */
  async _sendVerifyCodeMail(username, email, code) {
    try {
      return await this.mailer.sendVerifyCode(
        { email, username, code },
        { ttlMs: LIMITS.VERIFY_CODE_TTL_MS, ...this.smtp }
      );
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 注册：校验格式 -> 唯一性 -> 发码 -> 建待验证用户 */
  async _handleRegister(session, data, id) {
    const username = data.username;
    const password = data.password;
    const email = data.email;

    if (!P.isValidUsername(username) || typeof password !== 'string' || !password) {
      return this._send(session, P.frame(S2C.REGISTER_ERR, { code: 'bad_format', message: '用户名或密码格式不正确' }, id));
    }
    if (!P.isValidEmail(email)) {
      return this._send(session, P.frame(S2C.REGISTER_ERR, { code: 'bad_email', message: '邮箱格式不正确' }, id));
    }
    if (this.store.hasUser(username)) {
      return this._send(session, P.frame(S2C.REGISTER_ERR, { code: 'user_exists', message: '用户名已被占用' }, id));
    }
    if (this.store.emailExists(email)) {
      return this._send(session, P.frame(S2C.REGISTER_ERR, { code: 'email_exists', message: '邮箱已被注册' }, id));
    }
    if (!session.allowRequest()) {
      return this._send(session, P.frame(S2C.REGISTER_ERR, { code: 'rate_limited', message: '发送过于频繁' }, id));
    }

    const code = this._genCode();
    const sent = await this._sendVerifyCodeMail(username, email, code);
    if (!sent.ok) {
      return this._send(session, P.frame(S2C.REGISTER_ERR, { code: 'mail_failed', message: '验证码发送失败，请稍后重试' }, id));
    }
    // 建待验证用户 + 存验证码
    this.store.createUser(username, password, email);
    this.store.setVerifyCode(username, code, LIMITS.VERIFY_CODE_TTL_MS);
    if (sent.devMode && sent.code) {
      process.stdout.write(`[mailer] 验证码 for ${username} (${email}): ${sent.code}\n`);
    }
    this._send(
      session,
      P.frame(S2C.REGISTER_OK, { user: username, needVerify: true, devMode: !!sent.devMode }, id)
    );
  }

  /** 提交邮箱验证码 */
  _handleVerifyEmail(session, data, id) {
    const username = data.username;
    const code = data.code;

    if (!P.isValidUsername(username) || !P.isValidVerifyCode(code)) {
      return this._send(session, P.frame(S2C.VERIFY_ERR, { code: 'bad_format', message: '用户名或验证码格式不正确' }, id));
    }
    if (!this.store.hasUser(username)) {
      return this._send(session, P.frame(S2C.VERIFY_ERR, { code: 'no_user', message: '用户不存在' }, id));
    }
    const result = this.store.verifyEmail(username, code);
    if (!result.ok) {
      const reasonMsg = {
        no_code: '请先注册获取验证码',
        expired: '验证码已过期，请重新获取',
        too_many_attempts: '尝试次数过多，请重新获取验证码',
        wrong_code: `验证码错误，剩余 ${this.store.verifyAttemptsLeft(username)} 次`,
        already_verified: '账号已验证',
      }[result.reason] || '验证失败';
      return this._send(session, P.frame(S2C.VERIFY_ERR, { code: result.reason, message: reasonMsg }, id));
    }
    // 验证通过，直接返回 AUTH_OK 让客户端进聊天
    session.user = username;
    this.sessions.set(username, session);
    this._send(
      session,
      P.frame(S2C.AUTH_OK, {
        user: username,
        rooms: this.store.listRooms(),
        server: this.serverName,
        avatar: this.store.getAvatar(username),
      }, id)
    );
    this._broadcastPresence(username, true);
    this._sendToAll(P.frame(S2C.SYSTEM, { event: 'user_joined', user: username, at: Date.now() }), username);
    setImmediate(() => this._flushInbox(session));
  }

  /** 重发验证码 */
  async _handleResendCode(session, data, id) {
    const username = data.username;
    if (!P.isValidUsername(username)) {
      return this._send(session, P.frame(S2C.VERIFY_ERR, { code: 'bad_format', message: '用户名格式不正确' }, id));
    }
    const user = this.store.users.get(username);
    if (!user || !user.email) {
      return this._send(session, P.frame(S2C.VERIFY_ERR, { code: 'no_user', message: '用户不存在或没有邮箱' }, id));
    }
    const code = this._genCode();
    const sent = await this._sendVerifyCodeMail(username, user.email, code);
    if (!sent.ok) {
      return this._send(session, P.frame(S2C.VERIFY_ERR, { code: 'mail_failed', message: '重发失败，请稍后重试' }, id));
    }
    this.store.setVerifyCode(username, code, LIMITS.VERIFY_CODE_TTL_MS);
    if (sent.devMode && sent.code) {
      process.stdout.write(`[mailer] 重发验证码 for ${username} (${user.email}): ${sent.code}\n`);
    }
    this._send(session, P.frame(S2C.VERIFY_OK, { resent: true }, id));
  }

  _flushInbox(session) {
    const offline = this._pendingInbox.get(session.user);
    if (!offline || offline.length === 0) return;
    this._pendingInbox.delete(session.user);
    for (const message of offline) {
      this._send(session, P.frame(S2C.MSG, { ...message, offline: true }));
    }
  }

  // ---------------------------------------------------------------- 私聊
  _handlePrivateMessage(session, data, id) {
    const to = data.to;
    const text = typeof data.text === 'string' ? data.text : '';
    const image = data.image === undefined || data.image === null ? null : data.image;
    const video = data.video === undefined || data.video === null ? null : data.video;
    const videoUrl = data.videoUrl === undefined || data.videoUrl === null ? null : data.videoUrl;
    const imageUrl = data.imageUrl === undefined || data.imageUrl === null ? null : data.imageUrl;
    if (!P.isValidUsername(to)) {
      return this._error(session, ERR.BAD_REQUEST, '收件人用户名非法', id);
    }
    if (!P.isValidText(text) && !image && !imageUrl && !video && !videoUrl) {
      return this._error(session, ERR.BAD_REQUEST, `消息内容长度需在 1~${LIMITS.MAX_TEXT} 之间`, id);
    }
    if (image && !P.isValidImageDataUrl(image) && !P.isValidGifDataUrl(image)) {
      return this._error(session, ERR.BAD_REQUEST, '图片格式非法或超过大小限制', id);
    }
    if (imageUrl && !P.isValidImageUrl(imageUrl)) {
      return this._error(session, ERR.BAD_REQUEST, '图片地址非法或超过大小限制', id);
    }
    if (video && !P.isValidVideoDataUrl(video)) {
      return this._error(session, ERR.BAD_REQUEST, '视频格式非法或超过大小限制', id);
    }
    if (videoUrl && !P.isValidVideoUrl(videoUrl)) {
      return this._error(session, ERR.BAD_REQUEST, '视频地址非法或超过大小限制', id);
    }
    if (to === session.user) {
      return this._error(session, ERR.BAD_REQUEST, '不能给自己发私聊', id);
    }

    const message = {
      id: `m${P.nowMs()}_${Math.floor(Math.random() * 1e6)}`,
      from: session.user,
      to,
      text,
      ts: P.nowMs(),
    };
    if (image) message.image = image;
    if (imageUrl) message.imageUrl = imageUrl;
    if (video) message.video = video;
    if (videoUrl) message.videoUrl = videoUrl;
    this.store.appendDm(session.user, to, message);

    const target = this.sessions.get(to);
    if (target) {
      this._send(target, P.frame(S2C.MSG, message));
      this._send(session, P.frame(S2C.ACK, { ok: true, kind: 'msg', message }, id));
    } else {
      // 对方离线：入信箱，等其上线后投递
      if (!this._pendingInbox.has(to)) this._pendingInbox.set(to, []);
      this._pendingInbox.get(to).push(message);
      this._send(
        session,
        P.frame(S2C.ACK, { ok: true, kind: 'msg', message, delivered: false, note: '对方离线，消息已存入信箱' }, id)
      );
    }
  }

  // ---------------------------------------------------------------- 群聊
  _handleGroupMessage(session, data, id) {
    const room = data.room;
    const text = typeof data.text === 'string' ? data.text : '';
    const image = data.image === undefined || data.image === null ? null : data.image;
    const video = data.video === undefined || data.video === null ? null : data.video;
    const videoUrl = data.videoUrl === undefined || data.videoUrl === null ? null : data.videoUrl;
    const imageUrl = data.imageUrl === undefined || data.imageUrl === null ? null : data.imageUrl;
    if (!P.isValidRoomName(room)) {
      return this._error(session, ERR.BAD_REQUEST, '群名称非法', id);
    }
    if (!P.isValidText(text) && !image && !imageUrl && !video && !videoUrl) {
      return this._error(session, ERR.BAD_REQUEST, `消息内容长度需在 1~${LIMITS.MAX_TEXT} 之间`, id);
    }
    if (image && !P.isValidImageDataUrl(image) && !P.isValidGifDataUrl(image)) {
      return this._error(session, ERR.BAD_REQUEST, '图片格式非法或超过大小限制', id);
    }
    if (imageUrl && !P.isValidImageUrl(imageUrl)) {
      return this._error(session, ERR.BAD_REQUEST, '图片地址非法或超过大小限制', id);
    }
    if (video && !P.isValidVideoDataUrl(video)) {
      return this._error(session, ERR.BAD_REQUEST, '视频格式非法或超过大小限制', id);
    }
    if (videoUrl && !P.isValidVideoUrl(videoUrl)) {
      return this._error(session, ERR.BAD_REQUEST, '视频地址非法或超过大小限制', id);
    }
    if (!this.store.isMember(room, session.user)) {
      return this._error(session, ERR.NOT_IN_ROOM, `你还不是群「${room}」的成员，请先 join`, id);
    }

    const message = {
      id: `g${P.nowMs()}_${Math.floor(Math.random() * 1e6)}`,
      room,
      from: session.user,
      text,
      ts: P.nowMs(),
    };
    if (image) message.image = image;
    if (imageUrl) message.imageUrl = imageUrl;
    if (video) message.video = video;
    if (videoUrl) message.videoUrl = videoUrl;
    this.store.appendRoomMessage(room, message);

    // 广播给群内所有在线成员
    const members = this.store.listMembers(room);
    for (const member of members) {
      const s = this.sessions.get(member);
      if (s) this._send(s, P.frame(S2C.GROUP, message));
    }
    this._send(session, P.frame(S2C.ACK, { ok: true, kind: 'group', message }, id));
  }

  _handleJoin(session, data, id) {
    const room = data.room;
    if (!P.isValidRoomName(room)) {
      return this._error(session, ERR.BAD_REQUEST, '群名称非法', id);
    }
    const existed = this.store.hasRoom(room);
    this.store.joinRoom(room, session.user);
    session.rooms.add(room);
    const created = !existed;
    this._send(
      session,
      P.frame(S2C.JOIN_OK, { room, created, members: this.store.listMembers(room) }, id)
    );
    // 通知群内其他成员
    for (const member of this.store.listMembers(room)) {
      if (member === session.user) continue;
      const s = this.sessions.get(member);
      if (s) this._send(s, P.frame(S2C.SYSTEM, { event: 'member_joined', user: session.user, room }));
    }
  }

  _handleLeave(session, data, id) {
    const room = data.room;
    if (!P.isValidRoomName(room)) {
      return this._error(session, ERR.BAD_REQUEST, '群名称非法', id);
    }
    const ok = this.store.leaveRoom(room, session.user);
    session.rooms.delete(room);
    this._send(session, P.frame(S2C.LEAVE_OK, { room, ok }, id));
    for (const member of this.store.listMembers(room)) {
      const s = this.sessions.get(member);
      if (s) this._send(s, P.frame(S2C.SYSTEM, { event: 'member_left', user: session.user, room }));
    }
  }

  _handleMembers(session, data, id) {
    const room = data.room;
    if (!P.isValidRoomName(room)) {
      return this._error(session, ERR.BAD_REQUEST, '群名称非法', id);
    }
    this._send(
      session,
      P.frame(S2C.MEMBERS, { room, members: this.store.listMembers(room), exists: this.store.hasRoom(room) }, id)
    );
  }

  /** 资料：设置或查询头像 */
  _handleProfile(session, data, id) {
    const action = data.action || (data.avatar !== undefined ? 'set' : 'get');
    if (action === 'set') {
      const avatar = data.avatar;
      if (!P.isValidAvatarDataUrl(avatar)) {
        return this._error(session, ERR.BAD_REQUEST, '头像格式非法或超过大小限制', id);
      }
      this.store.setAvatar(session.user, avatar);
      this._send(session, P.frame(S2C.PROFILE, { user: session.user, avatar }, id));
      // 广播给所有在线客户端，便于实时刷新头像
      this._sendToAll(
        P.frame(S2C.SYSTEM, { event: 'avatar', user: session.user, avatar, at: P.nowMs() }),
        session.user
      );
      return;
    }
    if (action === 'get') {
      const user = data.user || session.user;
      if (!P.isValidUsername(user)) {
        return this._error(session, ERR.BAD_REQUEST, '用户名非法', id);
      }
      this._send(session, P.frame(S2C.PROFILE, { user, avatar: this.store.getAvatar(user) }, id));
      return;
    }
    this._error(session, ERR.BAD_REQUEST, `未知 action: ${action}`, id);
  }

  _handleHistory(session, data, id) {
    const limit = Number.isInteger(data.limit) ? data.limit : 50;
    if (data.room) {
      if (!P.isValidRoomName(data.room)) {
        return this._error(session, ERR.BAD_REQUEST, '群名称非法', id);
      }
      const messages = this.store.roomHistory(data.room, limit);
      return this._send(session, P.frame(S2C.HISTORY, { scope: 'room', room: data.room, messages }, id));
    }
    if (data.to) {
      if (!P.isValidUsername(data.to)) {
        return this._error(session, ERR.BAD_REQUEST, '用户名非法', id);
      }
      const messages = this.store.dmHistory(session.user, data.to, limit);
      return this._send(session, P.frame(S2C.HISTORY, { scope: 'dm', with: data.to, messages }, id));
    }
    return this._error(session, ERR.BAD_REQUEST, 'history 需要指定 room 或 to', id);
  }

  // ---------------------------------------------------------------- 工具
  _error(session, code, message, id) {
    this._send(session, P.frame(S2C.ERROR, { code, message }, id));
  }

  _send(session, obj) {
    if (!session || !session.socket || session.socket.destroyed) return;
    // 加密连接：整帧封进 {"e":"..."}，分帧方式（一行 JSON）保持不变
    const outbound = session.crypto ? session.crypto.seal(obj) : obj;
    session.socket.write(P.encode(outbound));
  }

  _sendToAll(frameObj, exceptUser) {
    for (const [username, session] of this.sessions) {
      if (username === exceptUser) continue;
      this._send(session, frameObj);
    }
  }

  _broadcastPresence(username, online) {
    this._sendToAll(P.frame(S2C.PRESENCE, { user: username, online, at: Date.now() }));
  }

  /** 服务端主动向所有在线用户发系统消息（用于公告 / stdin 广播） */
  broadcast(text, from = SYSTEM_USER) {
    const message = { id: `s${P.nowMs()}`, room: null, from, text, ts: P.nowMs(), system: true };
    this._sendToAll(P.frame(S2C.SYSTEM, { event: 'announcement', ...message }));
    return message;
  }

  /** 供 stdin 使用的广播入口 */
  _startStdin() {
    if (this._stdin) return;
    this._stdin = readline.createInterface({ input: process.stdin, terminal: false });
    this._stdin.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      this.broadcast(text);
      process.stdout.write(`[broadcast] ${text}\n`);
    });
    this._stdin.on('close', () => {
      this._stdin = null;
    });
  }

  _stopStdin() {
    if (this._stdin) {
      this._stdin.close();
      this._stdin = null;
    }
  }
}

/** 便捷工厂：供测试与嵌入使用 */
async function createChatServer(options = {}) {
  const server = new ChatServer(options);
  await server.start();
  return server;
}

module.exports = { ChatServer, createChatServer, Session, SYSTEM_USER };

// ------------------------------------------------------------------ CLI 入口
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const server = new ChatServer({
    host: args.host,
    port: args.port,
    dataDir: args.data,
    serverName: args.name,
    demo: args.demo,
    requireSecure: args.requireSecure,
    requireEmailVerify: args.requireEmailVerify,
    smtp: {
      host: args.smtpHost,
      port: args.smtpPort,
      secure: args.smtpSecure,
      user: args.smtpUser,
      pass: args.smtpPass,
      from: args.smtpFrom,
    },
  });

  server
    .start()
    .then(() => {
      console.log(`✅ ${server.serverName} 已启动`);
      console.log(`   监听地址: ${server.host}:${server.port}`);
      console.log(`   数据目录: ${server.dataDir}`);
      const lan = localAddresses();
      if (lan.length) {
        for (const item of lan) {
          console.log(`   局域网地址: http://${item.address}:${server.port}  (网卡 ${item.name}，手机可用它连接)`);
        }
      }
      console.log(`   提示: 手机 App 登录页选「外部服务器」，填上面的 IP 与端口即可连接`);
      if (args.demo) console.log('   演示账号: alice / bob / carol，密码均为 123456');
      if (!args.noStdin) {
        console.log('   提示: 直接输入文本回车可向所有在线用户广播系统公告，Ctrl+C 退出');
        server._startStdin();
      }
    })
    .catch((err) => {
      console.error('启动失败:', err.message);
      process.exit(1);
    });

  const shutdown = () => {
    console.log('\n正在关闭服务端...');
    server.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** 列出本机可用的局域网 IPv4 地址（方便手机/其它设备连过来） */
function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      const family = typeof addr.family === 'string' ? addr.family : `IPv${addr.family}`;
      if (family === 'IPv4' && !addr.internal) out.push({ name, address: addr.address });
    }
  }
  return out;
}

/** 简单的命令行参数解析 */
function parseArgs(argv) {
  const out = { host: '0.0.0.0', port: 9099, data: path.join(__dirname, '..', 'data'), demo: false, noStdin: false, requireEmailVerify: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--data' || a === '--data-dir') out.data = path.resolve(argv[++i]);
    else if (a === '--name') out.serverName = argv[++i];
    else if (a === '--demo') out.demo = true;
    else if (a === '--no-stdin') out.noStdin = true;
    else if (a === '--require-secure') out.requireSecure = true;
    else if (a === '--allow-plaintext') out.requireSecure = false;
    else if (a === '--no-email-verify') out.requireEmailVerify = false;
    else if (a === '--smtp-host') out.smtpHost = argv[++i];
    else if (a === '--smtp-port') out.smtpPort = Number(argv[++i]);
    else if (a === '--smtp-secure') out.smtpSecure = argv[++i];
    else if (a === '--smtp-user') out.smtpUser = argv[++i];
    else if (a === '--smtp-pass') out.smtpPass = argv[++i];
    else if (a === '--smtp-from') out.smtpFrom = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node src/server.js [选项]

选项:
  --host <addr>     监听地址（默认 0.0.0.0）
  --port <port>     监听端口（默认 9099）
  --data <dir>      数据目录（默认 ./data）
  --name <name>     服务端名称（默认 node-chat-server）
  --demo            创建演示账号 alice/bob/carol（密码 123456）与 general/dev 群
  --no-stdin        不监听标准输入广播
  --require-secure  只接受加密连接（1.1.0 起默认开启，此参数保留兼容写法）
  --allow-plaintext 允许明文连接（放弃强制加密，仅内网调试用）
  --no-email-verify 关闭邮箱验证登录（默认开启：注册需邮箱验证码）
  --smtp-host <h>   SMTP 服务器地址（发验证码邮件；缺省则验证码打到日志降级）
  --smtp-port <p>   SMTP 端口（默认 465）
  --smtp-secure <m> SMTP 加密：tls | starttls | none（默认按端口）
  --smtp-user <u>   SMTP 用户名（可选）
  --smtp-pass <p>   SMTP 密码（可选）
  --smtp-from <e>   SMTP 发件人地址（可选）
  -h, --help        显示帮助`);
      process.exit(0);
    }
  }
  return out;
}
