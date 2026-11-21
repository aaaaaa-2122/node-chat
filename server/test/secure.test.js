'use strict';

/**
 * 传输加密的端到端测试。
 *
 * 跑法：node --test test/
 * 重点不是「能连上」，而是三件容易假装成立的事：
 *   1. 明文客户端没被加密改坏（兼容性）；
 *   2. 线上字节里**真的**找不到密码和正文（不是「我以为加密了」）；
 *   3. 服务端身份变化时客户端**拒绝**连接，而不是默默接受。
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createChatServer } = require('../src/server');
const { connect } = require('../src/client-lib');
const P = require('../src/protocol');

const { C2S, S2C } = P;

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nc-${name}-`));
}

/**
 * 取一个可用端口。
 * 不用 listen(0)：这台机器上临时端口段已经吃紧，listen(0) 会直接 ENOBUFS。
 */
async function freePort() {
  for (let i = 0; i < 60; i++) {
    const port = 20000 + Math.floor(Math.random() * 9000);
    const ok = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('找不到可用端口');
}

async function boot(options = {}) {
  const dataDir = options.dataDir || tmpDir('srv');
  const port = options.port || (await freePort());
  const server = await createChatServer({ host: '127.0.0.1', port, dataDir, demo: true, ...options });
  return server;
}

/**
 * 一个能记录双向字节的 TCP 代理。
 * 用它才能验证「线上到底有没有明文」，而不是只信代码注释。
 */
async function tapProxy(targetPort) {
  const captured = [];
  const sockets = new Set();
  const proxy = net.createServer((client) => {    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    client.on('data', (chunk) => {
      captured.push(chunk);
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => client.write(chunk));
    const kill = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', kill);
    upstream.on('error', kill);
    client.on('close', kill);
    upstream.on('close', kill);
  });
  const port = await freePort();
  return new Promise((resolve) => {
    proxy.listen(port, '127.0.0.1', () => {
      resolve({
        port: proxy.address().port,
        bytes: () => Buffer.concat(captured),
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            proxy.close(() => r());
          }),
      });
    });
  });
}

test('明文客户端照常可用（加密没有破坏兼容）', async () => {
  const server = await boot();
  try {
    const alice = await connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'alice',
      password: '123456',
    });
    assert.strictEqual(alice.crypto, null, '明文连接不该有加密信道');
    await alice.joinRoom('general');
    const ack = await alice.sendToRoom('general', '明文还能说话');
    assert.ok(ack.message.id);
    alice.close();
  } finally {
    await server.stop();
  }
});

test('加密客户端能握手、登录、发消息', async () => {
  const server = await boot();
  try {
    const pinFile = path.join(tmpDir('pin'), 'known.json');
    const alice = await connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'alice',
      password: '123456',
      secure: true,
      pinFile,
    });
    assert.ok(alice.crypto, '应当建立加密信道');
    assert.match(alice.fingerprint, /^[0-9a-f]{8}:/, '指纹格式应可人眼比对');

    // bob 必须在 alice 发消息之前就在群里（群消息只广播给当时在线的成员）
    const bob = await connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'bob',
      password: '123456',
      secure: true,
      pinFile,
    });
    await bob.joinRoom('general');

    await alice.joinRoom('general');
    const ack = await alice.sendToRoom('general', '这条是密文');
    assert.ok(ack.message.id);

    const got = await bob.waitFor((m) => m.text === '这条是密文', 3000);
    assert.strictEqual(got.from, 'alice');

    // 首次连接写入 TOFU 记录
    const pins = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
    assert.strictEqual(pins[`127.0.0.1:${server.port}`], alice.fingerprint, '首次连接应记住服务端指纹');

    alice.close();
    bob.close();
  } finally {
    await server.stop();
  }
});

test('线上字节里找不到密码和正文，而明文连接能找到（对照组）', async () => {
  const server = await boot();
  const body = 'SECRET-' + Math.random().toString(36).slice(2, 10);
  try {
    // --- 加密连接 ---
    const secureTap = await tapProxy(server.port);
    const s = await connect({
      host: '127.0.0.1',
      port: secureTap.port,
      username: 'alice',
      password: '123456',
      secure: true,
      pinFile: path.join(tmpDir('pin'), 'k.json'),
    });
    await s.joinRoom('general');
    await s.sendToRoom('general', body);
    s.close();
    await new Promise((r) => setTimeout(r, 100));
    const secureBytes = secureTap.bytes().toString('latin1');
    await secureTap.close();

    assert.ok(!secureBytes.includes(body), '密文连接里不该出现正文');
    assert.ok(!secureBytes.includes('123456'), '密文连接里不该出现密码');
    assert.ok(secureBytes.includes('"e"'), '应当看到密文信封字段');

    // --- 明文对照：同样内容，必须能在字节里搜到 ---
    const plainTap = await tapProxy(server.port);
    const p = await connect({
      host: '127.0.0.1',
      port: plainTap.port,
      username: 'alice',
      password: '123456',
    });
    await p.joinRoom('general');
    await p.sendToRoom('general', body);
    p.close();
    await new Promise((r) => setTimeout(r, 100));
    const plainBytes = plainTap.bytes().toString('utf8');
    await plainTap.close();

    assert.ok(plainBytes.includes(body), '对照组：明文连接应当能看到正文（否则这个测试没有意义）');
    assert.ok(plainBytes.includes('123456'), '对照组：明文连接应当能看到密码');
  } finally {
    await server.stop();
  }
});

test('服务端指纹变了 → 客户端拒绝连接', async () => {
  const dir = tmpDir('srv');
  const server = await boot({ dataDir: dir });
  const pinFile = path.join(tmpDir('pin'), 'known.json');
  try {
    const first = await connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'alice',
      password: '123456',
      secure: true,
      pinFile,
    });
    const fp = first.fingerprint;
    first.close();

    // 篡改记录，模拟换了服务端
    const pins = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
    for (const k of Object.keys(pins)) pins[k] = 'deadbeef:deadbeef:deadbeef:deadbeef';
    fs.writeFileSync(pinFile, JSON.stringify(pins));

    await assert.rejects(
      connect({
        host: '127.0.0.1',
        port: server.port,
        username: 'alice',
        password: '123456',
        secure: true,
        pinFile,
      }),
      (err) => err.code === 'fp_changed'
    );
    assert.ok(fp);
  } finally {
    await server.stop();
  }
});

test('身份落盘：重启后指纹不变', async () => {
  const dir = tmpDir('srv');
  const s1 = await boot({ dataDir: dir });
  const fp1 = s1.identity.fp;
  await s1.stop();

  const s2 = await boot({ dataDir: dir });
  const fp2 = s2.identity.fp;
  await s2.stop();

  assert.strictEqual(fp1, fp2, '同一个 data 目录必须复用同一身份');
});

test('已加密连接收到明文帧 → 断开（防降级）', async () => {
  const server = await boot();
  const pinFile = path.join(tmpDir('pin'), 'k.json');
  try {
    const client = await connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'alice',
      password: '123456',
      secure: true,
      pinFile,
    });
    const socket = client.socket;

    const closed = new Promise((r) => socket.once('close', () => r(true)));
    // 绕过封包，直接塞一条明文帧
    socket.write(P.encode(P.frame(C2S.PING, {})));
    const didClose = await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 2000))]);
    assert.strictEqual(didClose, true, '服务端应当断开这条连接');
  } finally {
    await server.stop();
  }
});

test('指纹写不进去时连接仍成功，但会明确报出来（不能静默吞掉）', async () => {
  const server = await boot();
  const dir = tmpDir('pin');
  // 造一个「父路径是文件」的路径，让写入必然失败
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const warnings = [];
  try {
    const client = await connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'alice',
      password: '123456',
      secure: true,
      pinFile: path.join(blocker, 'known.json'),
      handlers: { error: (e) => warnings.push(e) },
    });
    assert.ok(client.crypto, '写不进指纹不该影响本次连接');
    assert.ok(client.pinWarning, '必须留下可见的告警');
    assert.match(client.pinWarning, /写不进去/);
    assert.ok(
      warnings.some((e) => e.code === 'pin_write_failed'),
      'error 事件里应当能看到 pin_write_failed'
    );
    client.close();
  } finally {
    await server.stop();
  }
});

test('requireSecure：明文客户端被拒，加密客户端可以进', async () => {
  const server = await boot({ requireSecure: true });
  try {
    await assert.rejects(
      connect({
        host: '127.0.0.1',
        port: server.port,
        username: 'alice',
        password: '123456',
        timeout: 3000,
      }),
      /加密|断开|超时/
    );

    const ok = await connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'alice',
      password: '123456',
      secure: true,
      pinFile: path.join(tmpDir('pin'), 'k.json'),
    });
    assert.ok(ok.crypto);
    ok.close();
  } finally {
    await server.stop();
  }
});
