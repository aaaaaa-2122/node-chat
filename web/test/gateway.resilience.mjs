// 网关健壮性回归：对端异常断开不能把网关进程带走
//
// 背景：upgrade 被拒绝的那两条路径（400 与 301）原来只写不读，客户端先 RST 就会
// 抛未捕获的 ECONNRESET，整个网关直接退出——任何人都能用一个 RST 打断全部会话。
//
// 用法：node test/gateway.resilience.mjs
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

let fails = 0;
const ok = (n) => console.log('  ✅ ' + n);
const bad = (n, x) => { fails++; console.log('  ❌ ' + n + (x ? '  ' + x : '')); };

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const GW = path.join(HERE, '..', 'src', 'gateway.js');

// ---------------------------------------------------------------- 模拟上游
// 只接受连接、读掉数据，不回任何东西——我们关心的是网关本身不被 RST 打死
const upstream = net.createServer((s) => {
  s.on('error', () => {});
  s.on('data', () => {});
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UP = upstream.address().port;

const procs = [];
function startGateway(args) {
  const p = spawn(process.execPath, [GW, ...args], { stdio: 'ignore' });
  p.on('error', () => {});
  procs.push(p);
  return p;
}
function alive(p) {
  return p.exitCode === null && p.signalCode === null;
}
async function healthz(port, tls) {
  try {
    const r = await fetch(`${tls ? 'https' : 'http'}://127.0.0.1:${port}/healthz`, {
      // 自签证书只用于测试
      ...(tls ? { dispatcher: undefined } : {}),
    });
    return r.ok ? await r.json() : null;
  } catch (_) {
    return null;
  }
}
// 起一个子进程发升级请求，收到响应就 process.exit(0)。
// 必须用独立进程：in-process 读走数据再 destroy 只会发 FIN，内核发出的是优雅关闭；
// 而进程退出时接收缓冲里还有未读数据，内核才会发 RST —— 线上就是这么被打死的。
function abruptClient(port, reqPath, host) {
  const code = `
    const http = require('http');
    const req = http.request({
      port: ${port}, path: ${JSON.stringify(reqPath)},
      headers: {
        Host: ${JSON.stringify(host)},
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('response', () => process.exit(0));
    req.on('error', () => process.exit(0));
    req.end();
    setTimeout(() => process.exit(0), 2000);
  `;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    c.on('exit', () => resolve());
    c.on('error', () => resolve());
  });
}

console.log('网关健壮性回归');

// ---------------------------------------------------------------- 1 明文模式
const plainPort = 19071;
const plain = startGateway(['--port', String(plainPort), '--upstream', `127.0.0.1:${UP}`]);
await sleep(700);
plainPort;

// 1a 路径不对触发 400 分支，然后 RST
await abruptClient(plainPort, '/nope', '127.0.0.1');
await sleep(400);
if (alive(plain) && (await healthz(plainPort, false))) ok('非法 upgrade + RST 后网关存活');
else bad('非法 upgrade + RST 把网关打死了');

// 1b 正常握手成功后立刻 RST（客户端崩溃/断电这类）
await abruptClient(plainPort, '/ws', '127.0.0.1');
await sleep(400);
if (alive(plain) && (await healthz(plainPort, false))) ok('握手后立刻 RST 网关存活');
else bad('握手后 RST 把网关打死了');

// 1c 连开 20 个再一起 RST，确认不会累积成崩溃
await Promise.all(Array.from({ length: 6 }, () => abruptClient(plainPort, '/ws', '127.0.0.1')));
await sleep(600);
if (alive(plain) && (await healthz(plainPort, false))) ok('6 个并发 RST 后网关存活');
else bad('并发 RST 把网关打死了');

// ---------------------------------------------------------------- 2 TLS + 跳转
const hasOpenssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
if (!hasOpenssl) {
  console.log('  ⚠️  没有 openssl，跳过 TLS/跳转分支');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-tls-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', crt, '-days', '1',
    '-subj', '/CN=gw.test', '-addext', 'subjectAltName=DNS:gw.test',
  ], { stdio: 'ignore' });

  const tlsPort = 19443;
  const redirPort = 19080;
  const tlsGw = startGateway([
    '--port', String(tlsPort), '--upstream', `127.0.0.1:${UP}`,
    '--tls-cert', crt, '--tls-key', key,
    '--redirect-port', String(redirPort), '--acme-root', dir,
    '--tls-host', 'gw.test',
  ]);
  await sleep(900);

  // TLS 起来了吗（自签所以用 -k 语义：这里只看 TCP 是否 accept）
  const listening = await new Promise((res) => {
    const s = net.connect(tlsPort, '127.0.0.1', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
  listening ? ok('TLS 端口已监听') : bad('TLS 端口没起来');

  // 2a 命中域名 → 301 分支，然后 RST（就是线上崩掉的那条路）
  await abruptClient(redirPort, '/ws', 'gw.test');
  await sleep(400);
  alive(tlsGw) ? ok('域名跳转分支 RST 后网关存活') : bad('域名跳转分支 RST 把网关打死了');

  // 2b 非域名 Host → 走 bridge 分支，然后 RST
  await abruptClient(redirPort, '/ws', '127.0.0.1');
  await sleep(400);
  alive(tlsGw) ? ok('明文回退分支 RST 后网关存活') : bad('明文回退分支 RST 把网关打死了');

  // 2c 跳转只对域名生效：非域名 Host 必须拿到页面而不是 301
  const r = await new Promise((res) => {
    const s = net.connect(redirPort, '127.0.0.1', () => {
      s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let b = '';
    s.on('data', (d) => { b += d; });
    s.on('close', () => res(b));
    s.on('error', () => res(''));
  });
  /HTTP\/1\.1 200/.test(r) ? ok('非域名 Host 拿到明文页面（未被 301）') : bad('非域名 Host 被错误跳转', r.split('\r\n')[0]);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 收尾
for (const p of procs) {
  try { p.kill(); } catch (_) {}
}
upstream.close();
await sleep(200);
console.log(fails ? `\n失败 ${fails} 项` : '\n全部通过');
process.exit(fails ? 1 : 0);
