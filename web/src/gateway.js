'use strict';

/**
 * Node Chat Web 网关
 * ------------------------------------------------------------------
 * 服务端只会说「NDJSON over TCP」，浏览器只会说「HTTP + WebSocket」。
 * 这个进程站在中间，做两件事：
 *
 *   1. 静态托管 public/（单页网页端）
 *   2. /ws 升级成 WebSocket，然后**逐帧透传**到上游 TCP 服务端
 *
 * 透传的意思是：它不懂聊天协议，只搬 JSON 行。浏览器发什么就转给服务端，
 * 服务端回什么就转给浏览器。协议将来加字段，这里一行都不用改。
 *
 * 零第三方依赖：WebSocket 的服务端握手与分帧按 RFC 6455 自己实现。
 *
 *   node src/gateway.js --port 80 --upstream 127.0.0.1:9099
 */

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ------------------------------------------------------------------ 参数
function parseArgs(argv) {
  const out = {
    host: '0.0.0.0',
    port: 8080,
    upstreamHost: '127.0.0.1',
    upstreamPort: 9099,
    root: path.join(__dirname, '..', 'public'),
    uploadDir: path.join(__dirname, '..', 'uploads'),
    maxFrame: 4 * 1024 * 1024,
    tlsCert: '',
    tlsKey: '',
    // 有证书时再开一个明文端口：ACME 验证 + 域名请求 301 到 https
    redirectPort: 0,
    acmeRoot: '/var/www/acme',
    // 只对这个 Host 做跳转；留空表示所有 Host 都跳。
    // 设成域名后，直接打 IP 的访问仍走明文——证书里没有 IP，
    // 无条件跳转会让 http://IP 变成「证书不匹配」的白屏告警页。
    tlsHost: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--host') out.host = next();
    else if (a === '--port') out.port = Number(next());
    else if (a === '--upstream') {
      const [h, p] = String(next()).split(':');
      out.upstreamHost = h || '127.0.0.1';
      out.upstreamPort = Number(p || 9099);
    } else if (a === '--root') out.root = path.resolve(next());
    else if (a === '--upload-dir') out.uploadDir = path.resolve(next());
    else if (a === '--max-frame') out.maxFrame = Number(next());
    else if (a === '--tls-cert') out.tlsCert = path.resolve(next());
    else if (a === '--tls-key') out.tlsKey = path.resolve(next());
    else if (a === '--redirect-port') out.redirectPort = Number(next());
    else if (a === '--acme-root') out.acmeRoot = path.resolve(next());
    else if (a === '--tls-host') out.tlsHost = String(next() || '').toLowerCase();
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node src/gateway.js [--port 8080] [--upstream 127.0.0.1:9099] [--root ./public]\n' +
          '                             [--upload-dir ./uploads] [--max-frame N]\n' +
          '                             [--tls-cert cert.pem --tls-key key.pem]\n' +
          '                             [--redirect-port 80] [--acme-root /var/www/acme]\n' +
          '                             [--tls-host 只对这个域名跳转 https]\n'
      );
      process.exit(0);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 静态文件
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogg': 'video/ogg',
  '.m4v': 'video/x-m4v',
};

// ------------------------------------------------------------------ 视频文件上传 / 静态托管

/** 单文件上限（分卷上传不受聊天单帧上限约束，这里给一个宽松总上限） */
const MAX_UPLOAD_SIZE = 200 * 1024 * 1024; // 200MB
/** 单块上限（浏览器按这个切分，也作为网关接收单块的上限） */
const MAX_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
/** 上传块保留的最长时间（超过视为未完成，清理时一并删除） */
const UPLOAD_STALE_MS = 24 * 60 * 60 * 1000; // 24h
/** 已完成视频文件的保留时长：超过 N 天自动清理 */
const FILE_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
/** 只接受这些扩展名作为上传文件 */
const UPLOAD_ALLOWED_EXT = new Set(['.mp4', '.webm', '.mov', '.ogg', '.m4v', '.gif']);

/** 服务上传文件 / 完成上传文件的静态托管 */
function serveUploadedFile(req, res, uploadDir, urlPath) {
  // urlPath 形如 /files/<stored>，只允许文件名安全字符，挡住 ../ 与绝对路径
  const seg = urlPath.slice('/files/'.length);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(seg)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const full = path.join(uploadDir, seg);
  // 再兜一层：解析后必须仍落在 uploadDir 内
  if (!full.startsWith(uploadDir + path.sep) && full !== uploadDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden');
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    // 视频支持 Range（拖动进度条），HTTP Range 是原生零依赖实现的
    const range = req.headers.range;
    let status = 200;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000',
    };
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
        return;
      }
      let start = m[1] === '' ? undefined : Number(m[1]);
      let end = m[2] === '' ? undefined : Number(m[2]);
      if (start === undefined) {
        // 后缀范围：最后 N 字节
        const n = end === undefined ? st.size : end;
        start = Math.max(0, st.size - n);
        end = st.size - 1;
      } else {
        if (end === undefined) end = st.size - 1;
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
        return;
      }
      end = Math.min(end, st.size - 1);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      fs.createReadStream(full, { start, end }).pipe(res);
      return;
    }
    res.writeHead(status, headers);
    fs.createReadStream(full).pipe(res);
  });
}

/** 处理分卷上传请求。请求体是二进制块，地址带 name/chunk/total。 */
function handleUpload(req, res, uploadDir, urlPath) {
  // urlPath 形如 /upload?name=xxx.mp4&chunk=0&total=8
  const u = new URL(urlPath, 'http://localhost');
  const name = String(u.searchParams.get('name') || '');
  const chunkRaw = u.searchParams.get('chunk');
  const totalRaw = u.searchParams.get('total');
  const chunk = Number(chunkRaw);
  const total = Number(totalRaw);

  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name, ext).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (!ext || !UPLOAD_ALLOWED_EXT.has(ext) || !base) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({ ok: false, error: '不支持的文件类型' })
    );
    return;
  }
  if (!Number.isInteger(chunk) || !Number.isInteger(total) || chunk < 0 || total < 1 || chunk >= total || total > 1000) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({ ok: false, error: 'chunk/total 参数非法' })
    );
    return;
  }
  if (!('content-length' in req.headers)) {
    res.writeHead(411, { 'Content-Type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({ ok: false, error: '缺少 Content-Length' })
    );
    return;
  }
  const bodyLen = Number(req.headers['content-length']);
  if (bodyLen > MAX_CHUNK_SIZE) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({ ok: false, error: '单块太大' })
    );
    return;
  }

  // 每个文件一个稳定 id：由 name+total 派生，这样同一次上传的所有分块落到同一组，天然可断点续传
  const id = crypto.createHash('sha1').update(base + ':' + ext + ':' + total).digest('hex').slice(0, 16);
  const partFile = path.join(uploadDir, `.${id}.${chunk}.part`);
  const chunks = [];
  let received = 0;
  req.on('data', (chunkData) => {
    received += chunkData.length;
    if (received > MAX_CHUNK_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }).end(
        JSON.stringify({ ok: false, error: '单块太大' })
      );
      req.destroy();
      return;
    }
    chunks.push(chunkData);
  });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    fs.writeFile(partFile, buf, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }).end(
          JSON.stringify({ ok: false, error: '写入失败' })
        );
        return;
      }
      // 判断是否已收齐所有块：每个块都存在
      const allParts = [];
      let complete = true;
      for (let i = 0; i < total; i += 1) {
        const p = path.join(uploadDir, `.${id}.${i}.part`);
        if (i !== chunk && !fs.existsSync(p)) {
          complete = false;
          break;
        }
        allParts.push(p);
      }
      if (!complete) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(
          JSON.stringify({ ok: true, received: chunk + 1, total })
        );
        return;
      }
      // 收齐全部块：按顺序拼接为最终文件
      const stored = `${id}${ext}`;
      const finalFile = path.join(uploadDir, stored);
      // 这里用流式拼接，避免大文件一次性占满内存
      const out = fs.createWriteStream(finalFile);
      const chain = () => {
        const part = allParts.shift();
        if (!part) {
          out.end();
          return;
        }
        // 注意：pipe() 返回的是目标（out）而不是源，必须把 'end' 挂在源可读流上
        const rs = fs.createReadStream(part);
        rs.on('error', () => out.destroy());
        rs.on('end', chain);
        rs.pipe(out, { end: false });
      };
      // 记录全部临时分块路径，用于合并完成后清理（chain 会 shift 消耗 allParts）
      const partList = allParts.slice();
      out.on('finish', () => {
        for (const pp of partList) {
          try { fs.unlinkSync(pp); } catch (_) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(
          JSON.stringify({ ok: true, url: `/files/${stored}`, size: fs.statSync(finalFile).size })
        );
      });
      out.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }).end(
          JSON.stringify({ ok: false, error: '合并失败' })
        );
      });
      chain();
    });
  });
  req.on('error', () => {
    /* 由上层统一处理 */
  });
}

/** 删除超过保留期的已完成文件，以及超过驻留时间的未完成分块。 */
function sweepUploads(uploadDir) {
  fs.readdir(uploadDir, (err, entries) => {
    if (err) return;
    const now = Date.now();
    for (const entry of entries) {
      const full = path.join(uploadDir, entry);
      let st;
      try {
        st = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (!st.isFile()) continue;
      const isPart = /^\..+\.\d+\.part$/.test(entry);
      // 视频文件超 7 天删除；未完成分块超 24h 删除
      const keepMs = isPart ? UPLOAD_STALE_MS : FILE_KEEP_MS;
      if (now - st.mtimeMs > keepMs) {
        try {
          fs.unlinkSync(full);
          console.log(`[upload] 清理过期文件: ${entry}（${Math.round((now - st.mtimeMs) / 3600000)}h 前写入）`);
        } catch (_) {}
      }
    }
  });
}

function serveStatic(req, res, root) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 只允许落在 root 内，挡住 ../ 与绝对路径
  const full = path.resolve(root, '.' + rel);
  if (!full.startsWith(root + path.sep) && full !== root) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const etag = `W/"${st.size}-${st.mtimeMs.toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ETag: etag,
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ------------------------------------------------------------------ WebSocket 帧
/** 解析客户端帧（浏览器发出的帧一定带掩码） */
class FrameParser {
  constructor(maxFrame) {
    this.buf = Buffer.alloc(0);
    this.maxFrame = maxFrame;
    this.frag = null; // 分片累积 {opcode, chunks, size}
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;

      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let offset = 2;

      if (rsv !== 0) throw new Error('rsv bit set');
      if (!masked) throw new Error('client frame must be masked');
      if (len === 126) {
        if (b.length < offset + 2) break;
        len = b.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (b.length < offset + 8) break;
        const big = b.readBigUInt64BE(offset);
        if (big > BigInt(this.maxFrame)) throw new Error('frame too large');
        len = Number(big);
        offset += 8;
      }
      if (len > this.maxFrame) throw new Error('frame too large');

      const isControl = opcode >= 0x8;
      if (isControl && (!fin || len > 125)) throw new Error('bad control frame');

      if (b.length < offset + 4 + len) break;
      const mask = b.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(b.subarray(offset, offset + len));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(offset + len);

      if (isControl) {
        out.push({ opcode, payload });
        continue;
      }

      if (opcode === 0x0) {
        if (!this.frag) throw new Error('unexpected continuation');
        this.frag.chunks.push(payload);
        this.frag.size += payload.length;
        if (this.frag.size > this.maxFrame) throw new Error('message too large');
        if (fin) {
          const merged = Buffer.concat(this.frag.chunks);
          out.push({ opcode: this.frag.opcode, payload: merged });
          this.frag = null;
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.frag) throw new Error('nested fragment');
        if (fin) out.push({ opcode, payload });
        else this.frag = { opcode, chunks: [payload], size: payload.length };
      } else {
        throw new Error('unknown opcode ' + opcode);
      }
    }
    return out;
  }
}

/** 服务端发往浏览器的帧（不掩码） */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  tooLarge: 1009,
  internal: 1011,
};

function closeFrame(code, reason) {
  const r = Buffer.from(reason || '', 'utf8').subarray(0, 123);
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return encodeFrame(0x8, p);
}

// ------------------------------------------------------------------ 一条桥接
let seq = 0;

function bridge(socket, head, cfg, req) {
  const id = ++seq;
  const clientIp = (req.headers['x-forwarded-for'] || socket.remoteAddress || '').split(',')[0].trim();
  const tag = `[ws#${id} ${clientIp}]`;

  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + WS_GUID)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const upstream = net.connect(cfg.upstreamPort, cfg.upstreamHost);
  upstream.setNoDelay(true);

  let closed = false;
  const cleanup = (why) => {
    if (closed) return;
    closed = true;
    console.log(`${tag} 断开：${why}`);
    try {
      upstream.destroy();
    } catch (_) {}
    try {
      socket.destroy();
    } catch (_) {}
  };

  // ---- 浏览器 -> 服务端
  const parser = new FrameParser(cfg.maxFrame);
  socket.on('data', (chunk) => {
    let frames;
    try {
      frames = parser.push(chunk);
    } catch (e) {
      console.log(`${tag} 帧错误：${e.message}`);
      try {
        socket.write(closeFrame(CLOSE.protocolError, e.message));
      } catch (_) {}
      cleanup('帧协议错误');
      return;
    }
    for (const f of frames) {
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        // 原样转发；服务端按行解析，缺换行则补一个
        let payload = f.payload;
        if (payload.length && payload[payload.length - 1] !== 0x0a) {
          payload = Buffer.concat([payload, Buffer.from('\n')]);
        }
        if (!upstream.destroyed) upstream.write(payload);
      } else if (f.opcode === 0x8) {
        try {
          socket.write(closeFrame(CLOSE.normal, ''));
        } catch (_) {}
        cleanup('客户端关闭');
        return;
      } else if (f.opcode === 0x9) {
        socket.write(encodeFrame(0xa, f.payload));
      }
    }
  });

  // ---- 服务端 -> 浏览器
  const decoder = new StringDecoder('utf8');
  let buf = '';
  upstream.on('data', (chunk) => {
    buf += decoder.write(chunk);
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      if (!socket.destroyed) socket.write(encodeFrame(0x1, Buffer.from(line, 'utf8')));
    }
    if (buf.length > cfg.maxFrame) {
      console.log(`${tag} 上游单帧过大，断开`);
      cleanup('上游帧过大');
    }
  });

  upstream.on('error', (e) => {
    console.log(`${tag} 上游连接失败：${e.code || e.message}`);
    if (!socket.destroyed) {
      socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({
        type: 'error',
        data: { code: 'upstream_unavailable', message: '服务端暂时连不上，请稍后重试' },
      }))));
      socket.write(closeFrame(CLOSE.internal, 'upstream unavailable'));
    }
    cleanup('上游不可用');
  });

  upstream.on('close', () => cleanup('上游关闭'));
  socket.on('close', () => cleanup('socket 关闭'));
  socket.on('error', (e) => cleanup('socket 错误 ' + e.message));
}

// ------------------------------------------------------------------ HTTP
/** ACME http-01 验证：token 只认安全字符，文件从 acmeRoot 直读，不经过静态托管 */
function serveAcme(req, res, acmeRoot) {
  const token = req.url.split('?')[0].slice('/.well-known/acme-challenge/'.length);
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(token)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }
  fs.readFile(path.join(acmeRoot, token), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': data.length }).end(data);
  });
}

/**
 * acme.sh 续期会原地换掉证书文件。这里定期看 mtime，变了就热更——
 * 不重启进程，正在连着的 WebSocket 也不会被踢掉。
 */
function watchCert(server, cfg) {
  const stamp = () => {
    try {
      return fs.statSync(cfg.tlsCert).mtimeMs + fs.statSync(cfg.tlsKey).mtimeMs;
    } catch (_) {
      return 0;
    }
  };
  let last = stamp();
  const timer = setInterval(() => {
    const now = stamp();
    if (!now || now === last) return;
    try {
      server.setSecureContext({
        cert: fs.readFileSync(cfg.tlsCert),
        key: fs.readFileSync(cfg.tlsKey),
      });
      last = now;
      console.log('[tls] 证书已热更新（无需重启）');
    } catch (e) {
      console.log('[tls] 证书热更新失败：' + e.message);
    }
  }, Number(process.env.CERT_CHECK_MS || 5 * 60 * 1000));
  timer.unref();
}

function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const clients = { open: 0 };
  const root = cfg.root;
  const useTls = Boolean(cfg.tlsCert && cfg.tlsKey);

  const handler = (req, res) => {
    // 证书还没签发时也要能访问这条路径，所以放在最前面、且不做任何跳转
    if (req.url.startsWith('/.well-known/acme-challenge/')) {
      serveAcme(req, res, cfg.acmeRoot);
      return;
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (useTls) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    // 视频分卷上传：POST /upload?name=xx.mp4&chunk=i&total=n
    if (req.method === 'POST' && req.url.startsWith('/upload')) {
      handleUpload(req, res, cfg.uploadDir, req.url);
      return;
    }
    // 已上传视频的静态托管（支持 Range 拖动）：GET /files/<stored>
    if (req.method === 'GET' && req.url.startsWith('/files/')) {
      serveUploadedFile(req, res, cfg.uploadDir, req.url);
      return;
    }

    if (req.url === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        tls: useTls,
        upstream: `${cfg.upstreamHost}:${cfg.upstreamPort}`,
        clients: clients.open,
        uptimeSec: Math.round(process.uptime()),
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed');
      return;
    }
    serveStatic(req, res, root);
  };

  // 确保上传目录存在，并启动「过期视频/分块自动清理」定时器
  fs.mkdirSync(cfg.uploadDir, { recursive: true });
  const sweepTimer = setInterval(() => sweepUploads(cfg.uploadDir), Number(process.env.UPLOAD_SWEEP_MS || 3600 * 1000));
  sweepTimer.unref();

  // 有证书就上 HTTPS（WebSocket 自动变 wss，前端不用改）
  let server;
  if (useTls) {
    let opts;
    try {
      opts = { cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) };
    } catch (e) {
      // 不降级：说好上 HTTPS 却静默跑明文，比直接起不来更危险
      console.error(`证书读不了，拒绝以明文启动：${e.message}`);
      process.exit(1);
    }
    server = https.createServer(opts, handler);
    watchCert(server, cfg);
  } else {
    server = http.createServer(handler);
  }

  server.on('upgrade', (req, socket, head) => {
    const url = req.url.split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== '/ws' || !key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      // 拒绝路径也必须挂 error：对端先 RST 的话，光写不读会抛未捕获的 ECONNRESET，
      // 一个扫描器就能把整个网关带走
      socket.on('error', () => {});
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    clients.open += 1;
    socket.once('close', () => {
      clients.open -= 1;
    });
    bridge(socket, head, cfg, req);
  });

  server.listen(cfg.port, cfg.host, () => {
    process.stdout.write(
      `Node Chat Web 网关已启动\n` +
        `   监听:   ${useTls ? 'https' : 'http'}://${cfg.host}:${cfg.port}\n` +
        `   上游:   ${cfg.upstreamHost}:${cfg.upstreamPort}\n` +
        `   静态:   ${root}\n` +
        `   上传:   ${cfg.uploadDir}（视频保留 7 天，超期自动清理）\n`
    );
  });

  // 明文端口：ACME 验证 + 域名请求 301 到 https；其他 Host（例如直接打 IP）
  // 继续走明文，否则证书里没有 IP，浏览器会撞上白屏告警页
  let redirector = null;
  if (useTls && cfg.redirectPort) {
    const toHttps = (req) => {
      const host = String(req.headers.host || '').split(':')[0] || cfg.host;
      const portPart = cfg.port === 443 ? '' : `:${cfg.port}`;
      return `https://${host}${portPart}${req.url}`;
    };
    const wantRedirect = (req) => {
      if (!cfg.tlsHost) return true;
      const host = String(req.headers.host || '').split(':')[0].toLowerCase();
      return host === cfg.tlsHost;
    };
    redirector = http.createServer((req, res) => {
      if (req.url.startsWith('/.well-known/acme-challenge/')) {
        serveAcme(req, res, cfg.acmeRoot);
        return;
      }
      if (wantRedirect(req)) {
        res.writeHead(301, { Location: toHttps(req), 'Content-Length': 0 }).end();
        return;
      }
      handler(req, res);
    });
    redirector.on('upgrade', (req, socket, head) => {
      // 同上：任何只写不读的 socket 都要挂 error，否则对端 RST 会打穿进程
      socket.on('error', () => {});
      if (wantRedirect(req)) {
        socket.end(
          'HTTP/1.1 301 Moved Permanently\r\n' +
            `Location: ${toHttps(req)}\r\nConnection: close\r\n\r\n`
        );
        return;
      }
      clients.open += 1;
      socket.once('close', () => {
        clients.open -= 1;
      });
      bridge(socket, head, cfg, req);
    });
    redirector.listen(cfg.redirectPort, cfg.host, () => {
      process.stdout.write(
        `   跳转:   http://${cfg.host}:${cfg.redirectPort} -> https` +
          (cfg.tlsHost ? `（仅 ${cfg.tlsHost}，其他 Host 走明文）` : '') +
          '\n'
      );
    });
  }

  const stop = (sig) => {
    console.log(`收到 ${sig}，正在关闭`);
    if (redirector) redirector.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (require.main === module) main();

module.exports = { FrameParser, encodeFrame, parseArgs };
