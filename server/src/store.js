'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { LIMITS, dmKey, nowMs } = require('./protocol');

/**
 * 轻量级 JSON 文件存储（原子写 + 防抖落盘），零外部依赖。
 * 保存内容：用户（scrypt 加盐哈希）、群组、群消息历史、私聊历史。
 */
class Store {
  constructor(dir) {
    this.dir = dir;
    this.usersFile = path.join(dir, 'users.json');
    this.roomsFile = path.join(dir, 'rooms.json');
    this.dmFile = path.join(dir, 'dms.json');
    this.users = new Map(); // username -> { username, salt, hash, createdAt }
    this.rooms = new Map(); // name -> { name, createdAt, createdBy, members: [], history: [] }
    this.dms = new Map(); // dmKey -> [message]
    this._dirty = new Set();
    this._timer = null;
  }

  // -------------------------------------------------------------- 生命周期
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.users = new Map(Object.entries(this._readJson(this.usersFile, {})));
    this.rooms = new Map(Object.entries(this._readJson(this.roomsFile, {})));
    this.dms = new Map(Object.entries(this._readJson(this.dmFile, {})));
    // 迁移旧用户：老 users.json 没有 email/verified 字段，视为已验证（保留可登录）
    let migrated = false;
    for (const [name, user] of this.users) {
      if (user.verified === undefined) {
        user.verified = true;
        migrated = true;
      }
      if (user.email === undefined) {
        user.email = null;
        migrated = true;
      }
    }
    if (migrated) this._touch(this.usersFile);
    return this;
  }

  _readJson(file, fallback) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  /** 标记某个文件需要落盘（防抖 100ms） */
  _touch(file) {
    this._dirty.add(file);
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 100);
    if (this._timer.unref) this._timer.unref();
  }

  /** 立即把脏数据写盘 */
  flush() {
    for (const file of this._dirty) {
      const data =
        file === this.usersFile
          ? Object.fromEntries(this.users)
          : file === this.roomsFile
            ? Object.fromEntries(this.rooms)
            : Object.fromEntries(this.dms);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    }
    this._dirty.clear();
  }

  close() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.flush();
  }

  // ------------------------------------------------------------------ 用户
  hasUser(username) {
    return this.users.has(username);
  }

  /** 注册新用户，密码使用 scrypt 加盐哈希保存 */
  /**
   * 创建用户。邮箱验证模式下建的是「待验证」用户（verified:false），
   * 验证通过后由 activateUser 置为 true。老代码兼容时 verified 可缺省。
   */
  createUser(username, password, email) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
    const user = {
      username,
      salt,
      hash,
      email: email || null,
      verified: false, // 待邮箱验证
      createdAt: nowMs(),
      avatar: null,
      verifyCodeHash: null,
      verifyExpiresAt: 0,
      verifyAttempts: 0,
    };
    this.users.set(username, user);
    this._touch(this.usersFile);
    return user;
  }

  /** 该邮箱是否已被使用（已激活用户） */
  emailExists(email) {
    if (!email) return false;
    for (const u of this.users.values()) {
      if (u.email === email) return true;
    }
    return false;
  }

  /** 按邮箱找用户（返回 username，无则 null） */
  findByEmail(email) {
    if (!email) return null;
    for (const [name, u] of this.users) {
      if (u.email === email) return name;
    }
    return null;
  }

  /** 是否待验证用户（注册了但还没通过邮箱验证） */
  isPending(username) {
    const u = this.users.get(username);
    return !!u && u.verified === false;
  }

  /** 设置验证码（存 scrypt 哈希，避免明文落盘）+ 过期时间 + 重置尝试次数 */
  setVerifyCode(username, code, ttlMs = LIMITS.VERIFY_CODE_TTL_MS) {
    const user = this.users.get(username);
    if (!user) return null;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(code), salt, 32).toString('hex');
    user.verifyCodeSalt = salt;
    user.verifyCodeHash = hash;
    user.verifyExpiresAt = nowMs() + ttlMs;
    user.verifyAttempts = 0;
    this._touch(this.usersFile);
    return user;
  }

  /** 校验验证码：比对 scrypt、检查过期与次数上限。返回 {ok, reason} */
  verifyEmail(username, code) {
    const user = this.users.get(username);
    if (!user) return { ok: false, reason: 'no_user' };
    if (user.verified) return { ok: false, reason: 'already_verified' };
    if (!user.verifyCodeHash) return { ok: false, reason: 'no_code' };
    if (nowMs() > user.verifyExpiresAt) return { ok: false, reason: 'expired' };
    if (user.verifyAttempts >= LIMITS.VERIFY_MAX_ATTEMPTS) {
      return { ok: false, reason: 'too_many_attempts' };
    }
    const candidate = crypto.scryptSync(String(code), user.verifyCodeSalt, 32);
    const expected = Buffer.from(user.verifyCodeHash, 'hex');
    let ok = false;
    if (candidate.length === expected.length) {
      ok = crypto.timingSafeEqual(candidate, expected);
    }
    user.verifyAttempts += 1;
    if (ok) {
      user.verified = true;
      user.verifyCodeHash = null;
      user.verifyCodeSalt = null;
      user.verifyExpiresAt = 0;
    }
    this._touch(this.usersFile);
    return ok ? { ok: true } : { ok: false, reason: 'wrong_code' };
  }

  /** 校验失败次数（供客户端提示剩余机会） */
  verifyAttemptsLeft(username) {
    const user = this.users.get(username);
    if (!user || !user.verifyCodeHash) return 0;
    return Math.max(0, LIMITS.VERIFY_MAX_ATTEMPTS - (user.verifyAttempts || 0));
  }

  verifyUser(username, password) {
    const user = this.users.get(username);
    if (!user) return false;
    const candidate = crypto.scryptSync(String(password), user.salt, 32);
    const expected = Buffer.from(user.hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  }

  listUsers() {
    return [...this.users.keys()].sort();
  }

  /** 设置用户头像（data URL） */
  setAvatar(username, dataUrl) {
    const user = this.users.get(username);
    if (!user) return null;
    user.avatar = dataUrl || null;
    this._touch(this.usersFile);
    return user;
  }

  getAvatar(username) {
    const user = this.users.get(username);
    return user && user.avatar ? user.avatar : null;
  }

  /** 全部已设置头像的用户 -> data URL */
  listAvatars() {
    const map = {};
    for (const [name, user] of this.users) {
      if (user.avatar) map[name] = user.avatar;
    }
    return map;
  }

  // ------------------------------------------------------------------ 群组
  hasRoom(name) {
    return this.rooms.has(name);
  }

  /** 不存在则创建并返回房间 */
  ensureRoom(name, creator) {
    let room = this.rooms.get(name);
    if (!room) {
      room = { name, createdAt: nowMs(), createdBy: creator || null, members: [], history: [] };
      this.rooms.set(name, room);
      this._touch(this.roomsFile);
    }
    return room;
  }

  getRoom(name) {
    return this.rooms.get(name) || null;
  }

  listRooms() {
    return [...this.rooms.values()]
      .map((r) => ({
        name: r.name,
        createdAt: r.createdAt,
        createdBy: r.createdBy,
        memberCount: r.members.length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  isMember(roomName, username) {
    const room = this.rooms.get(roomName);
    return !!room && room.members.includes(username);
  }

  joinRoom(roomName, username) {
    const room = this.ensureRoom(roomName, username);
    if (!room.members.includes(username)) {
      room.members.push(username);
      room.members.sort();
      this._touch(this.roomsFile);
    }
    return room;
  }

  leaveRoom(roomName, username) {
    const room = this.rooms.get(roomName);
    if (!room) return false;
    const idx = room.members.indexOf(username);
    if (idx === -1) return false;
    room.members.splice(idx, 1);
    this._touch(this.roomsFile);
    return true;
  }

  listMembers(roomName) {
    const room = this.rooms.get(roomName);
    return room ? [...room.members] : [];
  }

  /** 追加群消息并裁剪历史长度 */
  appendRoomMessage(roomName, message) {
    const room = this.ensureRoom(roomName, null);
    room.history.push(message);
    stripOldImages(room.history);
    if (room.history.length > LIMITS.HISTORY_KEEP) {
      room.history.splice(0, room.history.length - LIMITS.HISTORY_KEEP);
    }
    this._touch(this.roomsFile);
    return message;
  }

  roomHistory(roomName, limit = 50) {
    const room = this.rooms.get(roomName);
    if (!room) return [];
    const n = Math.max(1, Math.min(limit, LIMITS.MAX_HISTORY));
    return room.history.slice(-n);
  }

  // ------------------------------------------------------------------ 私聊
  appendDm(from, to, message) {
    const key = dmKey(from, to);
    let list = this.dms.get(key);
    if (!list) {
      list = [];
      this.dms.set(key, list);
    }
    list.push(message);
    if (list.length > LIMITS.HISTORY_KEEP) {
      list.splice(0, list.length - LIMITS.HISTORY_KEEP);
    }
    stripOldImages(list);
    this._touch(this.dmFile);
    return message;
  }

  dmHistory(a, b, limit = 50) {
    const list = this.dms.get(dmKey(a, b)) || [];
    const n = Math.max(1, Math.min(limit, LIMITS.MAX_HISTORY));
    return list.slice(-n);
  }
}

/**
 * 历史里只保留最近 IMAGE_HISTORY_KEEP 条消息的媒体（图片/视频），
 * 更早的消息保留文本但去掉媒体，避免存储无限膨胀。
 */
function stripOldImages(list) {
  const boundary = list.length - LIMITS.IMAGE_HISTORY_KEEP;
  for (let i = 0; i < boundary; i++) {
    const m = list[i];
    if (!m) continue;
    if (m.image) delete m.image;
    if (m.video) delete m.video;
  }
}

module.exports = { Store };
