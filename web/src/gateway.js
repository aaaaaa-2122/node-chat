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
    maxFrame: 2 * 1024 * 1024,
    tlsCert: '',
    tlsKey: '',
    // 有证书时再开一个明文端口：只做 ACME 验证和 301 跳转，不提供页面
    redirectPort: 0,
    acmeRoot: '/var/www/acme',
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
    else if (a === '--max-frame') out.maxFrame = Number(next());
    else if (a === '--tls-cert') out.tlsCert = path.resolve(next());
    else if (a === '--tls-key') out.tlsKey = path.resolve(next());
    else if (a === '--redirect-port') out.redirectPort = Number(next());
    else if (a === '--acme-root') out.acmeRoot = path.resolve(next());
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node src/gateway.js [--port 8080] [--upstream 127.0.0.1:9099] [--root ./public]\n' +
          '                             [--tls-cert cert.pem --tls-key key.pem]\n' +
          '                             [--redirect-port 80] [--acme-root /var/www/acme]\n'
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
};

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
        `   静态:   ${root}\n`
    );
  });

  // 明文端口：ACME 验证 + 其余一律 301 到 https
  let redirector = null;
  if (useTls && cfg.redirectPort) {
    const toHttps = (req) => {
      const host = String(req.headers.host || '').split(':')[0] || cfg.host;
      const portPart = cfg.port === 443 ? '' : `:${cfg.port}`;
      return `https://${host}${portPart}${req.url}`;
    };
    redirector = http.createServer((req, res) => {
      if (req.url.startsWith('/.well-known/acme-challenge/')) {
        serveAcme(req, res, cfg.acmeRoot);
        return;
      }
      res.writeHead(301, { Location: toHttps(req), 'Content-Length': 0 }).end();
    });
    redirector.on('upgrade', (req, socket) => {
      socket.end(
        'HTTP/1.1 301 Moved Permanently\r\n' +
          `Location: ${toHttps(req)}\r\nConnection: close\r\n\r\n`
      );
    });
    redirector.listen(cfg.redirectPort, cfg.host, () => {
      process.stdout.write(`   跳转:   http://${cfg.host}:${cfg.redirectPort} -> https\n`);
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
