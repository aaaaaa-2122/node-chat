'use strict';

/**
 * 协议定义：NDJSON over TCP
 * ------------------------------------------------------------------
 * 每一条消息都是一行 JSON（以 "\n" 结尾），形如：
 *   {"type": "msg", "id": "可选请求ID", "data": { ... }}
 *
 * 服务端与客户端共用本模块，保证两端类型名、限制定义完全一致。
 */

const VERSION = '1.0';

/** 客户端 -> 服务端 */
const C2S = Object.freeze({
  SECURE: 'secure', // 加密握手 {v, cpub}
  AUTH: 'auth', // 认证 {username, password}
  REGISTER: 'register', // 注册（发邮箱验证码）{username, password, email}
  VERIFY_EMAIL: 'verify_email', // 提交邮箱验证码 {username, code}
  RESEND_CODE: 'resend_code', // 重发验证码 {username}
  MSG: 'msg', // 私聊 {to, text, image?}
  GROUP: 'group', // 群聊 {room, text, image?}
  JOIN: 'join', // 加入群 {room}
  LEAVE: 'leave', // 退出群 {room}
  ROOMS: 'rooms', // 列出所有群
  MEMBERS: 'members', // 群成员 {room}
  WHO: 'who', // 在线用户
  HISTORY: 'history', // 历史消息 {room | to, limit}
  PROFILE: 'profile', // 资料 {action:'set'|'get', avatar?, user?}
  PING: 'ping', // 心跳
  QUIT: 'quit', // 主动断开
});

/** 服务端 -> 客户端 */
const S2C = Object.freeze({
  SECURE_OK: 'secure_ok', // 加密握手应答 {v, spub, idpub, sig, fp}
  SECURE_ERR: 'secure_err', // 加密握手失败 {code, message}
  AUTH_OK: 'auth_ok',
  AUTH_ERR: 'auth_err',
  REGISTER_OK: 'register_ok', // 注册受理 {user, needVerify:true}
  REGISTER_ERR: 'register_err', // 注册失败 {code, message}
  VERIFY_OK: 'verify_ok', // 验证通过
  VERIFY_ERR: 'verify_err', // 验证失败 {code, message}
  MSG: 'msg', // 收到私聊
  GROUP: 'group', // 收到群消息
  JOIN_OK: 'join_ok',
  LEAVE_OK: 'leave_ok',
  ROOMS: 'rooms',
  MEMBERS: 'members',
  WHO: 'who',
  HISTORY: 'history',
  PROFILE: 'profile', // 头像查询结果
  ACK: 'ack', // 对带 id 请求的应答
  ERROR: 'error', // 通用错误
  PONG: 'pong',
  SYSTEM: 'system', // 系统通知（上下线、公告、头像变更等）
  PRESENCE: 'presence', // 某用户上下线
});

/** 错误码 */
const ERR = Object.freeze({
  UNAUTHORIZED: 'unauthorized',
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  NOT_IN_ROOM: 'not_in_room',
  ALREADY_IN_ROOM: 'already_in_room',
  RATE_LIMIT: 'rate_limit',
  SECURE_REQUIRED: 'secure_required', // 服务端要求加密，客户端却发了明文
  INTERNAL: 'internal',
});

const LIMITS = Object.freeze({
  MAX_LINE: 3 * 1024 * 1024, // 单帧最大字节（图片以 data URL 内联，故放宽）
  // 加密后整帧变 base64（+33%）并带 iv/tag，明文上限不变但线上体积变大
  MAX_LINE_SECURE: 4096 * 1024,
  MAX_TEXT: 4000, // 单条消息最大字符数
  MAX_ROOM_NAME: 32,
  MAX_USERNAME: 24,
  MAX_EMAIL: 254, // 邮箱最大长度
  VERIFY_CODE_LEN: 6, // 邮箱验证码位数
  VERIFY_CODE_TTL_MS: 10 * 60 * 1000, // 验证码有效期
  VERIFY_MAX_ATTEMPTS: 5, // 验证码最大尝试次数
  MAX_HISTORY: 200, // 单次拉取的最大历史条数
  HISTORY_KEEP: 500, // 每个会话保留的历史条数
  MAX_IMAGE_LEN: 600 * 1000, // 单张图片（data URL）最大长度
  MAX_MEDIA_LEN: 1200 * 1000, // GIF / 动画（data URL）最大长度（放宽到能装动图）
  MAX_VIDEO_LEN: 2000 * 1000, // 短视频（data URL）最大长度
  MAX_VIDEO_URL_LEN: 256, // 已上传视频的引用 URL 长度上限（/files/xxx.mp4）
  MAX_AVATAR_LEN: 100 * 1000, // 头像（data URL）最大长度
  IMAGE_HISTORY_KEEP: 50, // 历史中保留图片的条数，更早的消息只保留文本
});

const USERNAME_RE = /^[A-Za-z0-9_一-龥.\-]{1,24}$/;
const ROOMNAME_RE = /^[A-Za-z0-9_一-龥.\-]{1,32}$/;

/** 编码一帧消息 */
function encode(obj) {
  return JSON.stringify(obj) + '\n';
}

/** 构造一帧消息 */
function frame(type, data, id) {
  const msg = { type, data: data === undefined ? {} : data };
  if (id !== undefined && id !== null) msg.id = id;
  return msg;
}

/**
 * 增量行解析器：把 TCP 分片还原成一条条 JSON 消息。
 */
class LineParser {
  constructor(maxLine = LIMITS.MAX_LINE) {
    this.buffer = '';
    this.maxLine = maxLine;
    this.overflow = false;
    // 正在丢弃一个超长帧的残尾（避免残尾被当成新帧解析）
    this.skipping = false;
  }

  /**
   * 喂入一段数据，返回解析出来的消息数组。
   * - 非法 JSON、超长帧会抛出会捕获的 Error（带 .code 属性）
   * - 超长帧会被整帧丢弃，其残尾不会被当成新帧解析
   * - 已成功解析的帧挂在 error.frames 上，调用方不会丢失它们
   */
  push(chunk) {
    this.buffer += chunk;
    const out = [];
    let error = null;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (this.skipping) {
        // 上一帧超长，这里是它的残尾，整段丢弃
        this.skipping = false;
        continue;
      }
      if (!line) continue;
      if (line.length > this.maxLine) {
        if (!error) {
          error = new Error(`message too large (>${this.maxLine})`);
          error.code = 'too_large';
        }
        continue;
      }
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        if (!error) {
          error = new Error(`invalid json: ${e.message}`);
          error.code = 'invalid_json';
        }
      }
    }
    if (this.buffer.length > this.maxLine) {
      // 还没遇到换行就已超长：丢弃到下一帧的换行符为止
      this.buffer = '';
      this.skipping = true;
      if (!error) {
        error = new Error(`message too large (>${this.maxLine})`);
        error.code = 'too_large';
      }
    }
    if (error) {
      error.frames = out;
      throw error;
    }
    return out;
  }
}

function isValidUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return typeof email === 'string' && email.length > 0 && email.length <= LIMITS.MAX_EMAIL && EMAIL_RE.test(email);
}

const VERIFY_CODE_RE = /^\d{6}$/;
function isValidVerifyCode(code) {
  return typeof code === 'string' && VERIFY_CODE_RE.test(code);
}

function isValidRoomName(name) {
  return typeof name === 'string' && ROOMNAME_RE.test(name);
}

function isValidText(text) {
  return typeof text === 'string' && text.length > 0 && text.length <= LIMITS.MAX_TEXT;
}

/** 图片必须是 data:image/...;base64,... 形式，且不超过长度上限 */
function isValidImageDataUrl(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('data:image/') &&
    value.length <= LIMITS.MAX_IMAGE_LEN
  );
}

/** 短视频：必须是 data:video/...;base64,... 形式，且不超过长度上限 */
function isValidVideoDataUrl(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('data:video/') &&
    value.length <= LIMITS.MAX_VIDEO_LEN
  );
}

/** GIF / 动画：是图片的一种，但要能装下动图体积（比静态图宽松） */
function isValidGifDataUrl(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('data:image/gif') &&
    value.length <= LIMITS.MAX_MEDIA_LEN
  );
}

/** 已上传视频的引用 URL：必须是 /files/<安全文件名> 形式，长度受限 */
function isValidVideoUrl(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('/files/') &&
    value.length <= LIMITS.MAX_VIDEO_URL_LEN &&
    /^\/files\/[A-Za-z0-9._-]{1,80}$/.test(value)
  );
}

/** 图片引用（同样走 /files/ HTTP 上传，与视频一致） */
function isValidImageUrl(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('/files/') &&
    value.length <= LIMITS.MAX_VIDEO_URL_LEN &&
    /^\/files\/[A-Za-z0-9._-]{1,80}$/.test(value)
  );
}

/** 头像同样用 data URL 承载，但体积上限更小 */
function isValidAvatarDataUrl(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('data:image/') &&
    value.length <= LIMITS.MAX_AVATAR_LEN
  );
}

/** 两人会话的稳定 key（与顺序无关），用于存储私聊历史 */
function dmKey(a, b) {
  return [a, b].sort().join(' ');
}

function nowMs() {
  return Date.now();
}

module.exports = {
  VERSION,
  C2S,
  S2C,
  ERR,
  LIMITS,
  encode,
  frame,
  LineParser,
  isValidUsername,
  isValidEmail,
  isValidVerifyCode,
  isValidRoomName,
  isValidText,
  isValidImageDataUrl,
  isValidAvatarDataUrl,
  isValidVideoDataUrl,
  isValidGifDataUrl,
  isValidVideoUrl,
  isValidImageUrl,
  dmKey,
  nowMs,
};
