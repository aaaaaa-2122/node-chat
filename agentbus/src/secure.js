'use strict';

/**
 * 传输加密（应用层，帧级）
 * ==================================================================
 * 目标：在不破坏「一行一条 JSON」这套分帧的前提下，给连接加一层可选加密。
 *
 * 为什么是帧级而不是换 TLS：
 *   1. 服务端要能**同时**接待加密客户端和明文客户端（桌面端 / 安卓端 / C# CLI
 *      暂时不动），TLS 只能在传输层一刀切，做不到按连接协商。
 *   2. 分帧保持不变——密文仍是 base64 单行，行解析器一行不用改。
 *
 * 握手（各一帧，明文）：
 *
 *   C→S  {"type":"secure","data":{"v":1,"cpub":"<b64 x25519 公钥 32B>"}}
 *   S→C  {"type":"secure_ok","data":{"v":1,"spub":"<b64>","idpub":"<b64 ed25519 32B>",
 *                                    "sig":"<b64>","fp":"<指纹>"}}
 *   S→C  {"type":"secure_err","data":{"code":"...","message":"..."}}
 *
 *   1. 客户端生成临时 X25519 密钥对，发出公钥。
 *   2. 服务端生成临时 X25519 密钥对，用自己的**长期 Ed25519 身份**对
 *      transcript = "nodechat/secure/1" || cpub || spub 签名。
 *   3. 双方 ECDH → HKDF-SHA256 派生两条方向的密钥（c2s / s2c 各 32 字节）。
 *
 * 帧（握手之后，双向）：
 *
 *   {"e":"<b64 iv12 || 密文 || tag16>"}
 *
 *   AES-256-GCM，AAD = 方向(1B) || 序号(8B 大端)。接收端要求序号严格递增，
 *   所以重放和乱序都会在解密阶段失败，而不是静默通过。
 *
 * 安全边界：
 *   - 服务端身份靠**长期 Ed25519 公钥指纹**认证，客户端 TOFU（首次信任并记住）。
 *   - 临时 X25519 提供前向保密：长期身份私钥泄露也解不开历史流量。
 *   - 只保护「客户端 ↔ 服务端」这一跳。服务端之间没有联邦，不做中继加密。
 *   - 不防「服务端本身就是恶意的」——它对明文有完全访问权，这是设计前提。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECURE_VERSION = 1;
const TRANSCRIPT_PREFIX = Buffer.from('nodechat/secure/1', 'utf8');

/** SPKI DER 头：X25519（OID 1.3.101.110）/ Ed25519（OID 1.3.101.112） */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const TAG_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;

function err(message, code) {
  const e = new Error(message);
  e.code = code || 'secure_error';
  return e;
}

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

function unb64(text) {
  return Buffer.from(String(text), 'base64');
}

/** 公钥对象 → 32 字节裸公钥 */
function rawPublicKey(keyObject) {
  const der = keyObject.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - KEY_LEN);
}

/** 32 字节裸公钥 → 公钥对象 */
function importRawPublicKey(raw, prefix, label) {
  const buf = Buffer.from(raw);
  if (buf.length !== KEY_LEN) throw err(`${label} 公钥长度应为 ${KEY_LEN} 字节，实际 ${buf.length}`, 'bad_pubkey');
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, buf]),
    format: 'der',
    type: 'spki',
  });
}

function newX25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey, privateKey };
}

/** 指纹：sha256(裸公钥) 前 16 字节，按 4 字节分组，便于人眼比对 */
function fingerprint(pubRaw) {
  const digest = crypto.createHash('sha256').update(Buffer.from(pubRaw)).digest('hex').slice(0, 32);
  return digest.replace(/(.{8})/g, '$1').match(/.{1,8}/g).join(':');
}

// ---------------------------------------------------------------- 身份

/**
 * 服务端长期身份（Ed25519）。
 * 首次启动生成并落到 dataDir/identity.json，之后一直复用——指纹变了就说明换了机器或密钥被删。
 */
function loadOrCreateIdentity(dataDir) {
  const file = path.join(dataDir, 'identity.json');
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const privateKey = crypto.createPrivateKey(saved.privateKey);
      const publicKey = crypto.createPublicKey(privateKey);
      const pubRaw = rawPublicKey(publicKey);
      return { file, privateKey, publicKey, pubRaw, fp: fingerprint(pubRaw), created: false };
    } catch (e) {
      throw err(`身份文件损坏（${file}）：${e.message}`, 'bad_identity');
    }
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = rawPublicKey(publicKey);
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ privateKey: pem, createdAt: Date.now() }, null, 2), {
    mode: 0o600,
  });
  return { file, privateKey, publicKey, pubRaw, fp: fingerprint(pubRaw), created: true };
}

// ---------------------------------------------------------------- 信道

/**
 * 单向加密帧的双向通道。
 * dir: 0 = 客户端→服务端，1 = 服务端→客户端（由「谁发起」决定）。
 */
class Channel {
  constructor(sendKey, recvKey, dir) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendDir = dir;
    this.recvDir = dir === 0 ? 1 : 0;
    this.sendSeq = 0;
    this.recvSeq = 0;
  }

  /** 把一帧明文对象封成 {"e": "..."} */
  seal(frame) {
    const seq = this.sendSeq++;
    const iv = crypto.randomBytes(IV_LEN);
    const aad = Buffer.alloc(9);
    aad.writeUInt8(this.sendDir, 0);
    aad.writeBigUInt64BE(BigInt(seq), 1);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, iv, { authTagLength: TAG_LEN });
    cipher.setAAD(aad);
    const body = Buffer.from(JSON.stringify(frame), 'utf8');
    const ct = Buffer.concat([cipher.update(body), cipher.final()]);
    return { e: b64(Buffer.concat([iv, ct, cipher.getAuthTag()])) };
  }

  /** 把 {"e": "..."} 解回明文对象；失败一律抛错，不返回半截结果 */
  open(envelope) {
    if (!envelope || typeof envelope.e !== 'string') {
      throw err('已加密连接收到明文帧（拒绝降级）', 'plaintext_on_secure');
    }
    const buf = unb64(envelope.e);
    if (buf.length < IV_LEN + TAG_LEN) throw err('密文帧过短', 'bad_frame');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);

    const aad = Buffer.alloc(9);
    aad.writeUInt8(this.recvDir, 0);
    aad.writeBigUInt64BE(BigInt(this.recvSeq), 1);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.recvKey, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    let plain;
    try {
      plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch (e) {
      // 序号对不上（重放/乱序）或密钥不对，都会走到这里
      throw err('解密失败：密钥不匹配、帧被篡改或序号不连续', 'decrypt_failed');
    }
    this.recvSeq += 1;
    try {
      return JSON.parse(plain.toString('utf8'));
    } catch (e) {
      throw err('解密后不是合法 JSON', 'bad_frame');
    }
  }
}

/** 由 ECDH 共享密钥派生两个方向的会话密钥 */
function deriveKeys(shared, cpub, spub) {
  const salt = crypto.createHash('sha256').update(Buffer.concat([cpub, spub])).digest();
  const c2s = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('nodechat-c2s'), KEY_LEN));
  const s2c = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('nodechat-s2c'), KEY_LEN));
  return { c2s, s2c };
}

// ---------------------------------------------------------------- 两端

/**
 * 服务端：处理 secure 帧，返回 {reply, channel}。
 * reply 必须**明文**发出，channel 在此之后生效。
 */
function acceptHandshake(identity, data) {
  const v = Number(data.v || SECURE_VERSION);
  if (v !== SECURE_VERSION) throw err(`不支持的加密版本 ${v}`, 'bad_version');
  const cpub = unb64(data.cpub || '');
  if (cpub.length !== KEY_LEN) throw err('客户端公钥长度不对', 'bad_pubkey');
  const clientPub = importRawPublicKey(cpub, X25519_SPKI_PREFIX, '客户端');

  const eph = newX25519();
  const spub = rawPublicKey(eph.publicKey);
  const transcript = Buffer.concat([TRANSCRIPT_PREFIX, cpub, spub]);
  const sig = crypto.sign(null, transcript, identity.privateKey);

  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: clientPub });
  const { c2s, s2c } = deriveKeys(shared, cpub, spub);

  return {
    reply: {
      v: SECURE_VERSION,
      spub: b64(spub),
      idpub: b64(identity.pubRaw),
      sig: b64(sig),
      fp: identity.fp,
    },
    // 服务端收 c2s、发 s2c；方向位由「谁发起」决定，这里 dir=1
    channel: new Channel(s2c, c2s, 1),
  };
}

/**
 * 客户端：处理 secure_ok，返回 channel。
 * expectedFp 为 null 表示首次连接（TOFU）；不为 null 时必须完全一致。
 */
function finishHandshake(data, clientKeys, clientPubRaw, expectedFp) {
  const v = Number(data.v || SECURE_VERSION);
  if (v !== SECURE_VERSION) throw err(`服务端要求加密版本 ${v}，本客户端只支持 ${SECURE_VERSION}`, 'bad_version');

  const spub = unb64(data.spub || '');
  const idpub = unb64(data.idpub || '');
  if (spub.length !== KEY_LEN || idpub.length !== KEY_LEN) throw err('服务端公钥长度不对', 'bad_pubkey');

  const serverPub = importRawPublicKey(spub, X25519_SPKI_PREFIX, '服务端');
  const idPubKey = importRawPublicKey(idpub, ED25519_SPKI_PREFIX, '服务端身份');
  const fp = fingerprint(idpub);

  if (data.fp && data.fp !== fp) throw err('服务端声明的指纹与公钥不符（可能被中间人篡改）', 'fp_mismatch');
  if (expectedFp && expectedFp !== fp) {
    throw err(
      `服务端身份指纹变了：期望 ${expectedFp}，实际 ${fp}。若非重装服务端，请立刻停止连接。`,
      'fp_changed'
    );
  }

  const transcript = Buffer.concat([TRANSCRIPT_PREFIX, clientPubRaw, spub]);
  const ok = crypto.verify(null, transcript, idPubKey, unb64(data.sig || ''));
  if (!ok) throw err('服务端签名验证失败', 'bad_signature');

  const shared = crypto.diffieHellman({ privateKey: clientKeys.privateKey, publicKey: serverPub });
  const { c2s, s2c } = deriveKeys(shared, clientPubRaw, spub);

  // 客户端发 c2s、收 s2c；dir=0
  return { channel: new Channel(c2s, s2c, 0), fp };
}

// ---------------------------------------------------------------- TOFU

/**
 * 简易 known_hosts：host:port -> 指纹。
 * 只做「记住首次见到的指纹」，不做证书链——自托管场景下这已经能挡住大部分中间人。
 */
class PinStore {
  constructor(file) {
    this.file = file || path.join(os.homedir(), '.nodechat', 'known-hosts.json');
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch (_) {
      this.data = {};
    }
  }

  key(host, port) {
    return `${host}:${port}`;
  }

  get(host, port) {
    return this.data[this.key(host, port)] || null;
  }

  set(host, port, fp) {
    this.data[this.key(host, port)] = fp;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (_) {
      /* 写不进去不影响本次连接，只是下次还要重新信任 */
    }
  }

  remove(host, port) {
    delete this.data[this.key(host, port)];
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (_) {}
  }
}

module.exports = {
  SECURE_VERSION,
  Channel,
  PinStore,
  acceptHandshake,
  finishHandshake,
  fingerprint,
  loadOrCreateIdentity,
  newX25519,
  rawPublicKey,
  b64,
  unb64,
};
