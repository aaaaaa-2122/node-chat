'use strict';

/**
 * 回归测试：服务端连不上时，重连必须只有一条链路。
 *
 * 历史 bug（2026-11-21，整机端口耗尽）：connect 失败会同时触发 close 回调和
 * Promise 的 catch，两处各自 setTimeout，同一失败分裂成两个重连循环，退避值
 * 还被乘两次（1s→4s→16s）。循环数按 2^n 增长，每个循环占一个临时端口，
 * 约 7 分钟就吃满 Windows 的 16384 个端口，全机新建连接 ENOBUFS。
 *
 * 这个用例只看一件事：9 秒内到底尝试了几次。修好后是 4 次（1+2+4 秒），
 * 翻倍 bug 下会是 15 次以上。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const DAEMON = path.join(__dirname, '..', 'src', 'daemon.js');
const WINDOW_MS = 9500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 拿一个当前空闲的端口；不监听，所以连接它必然失败 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('服务端不可达时，9 秒内重连次数不膨胀', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reconnect-'));
  const deadPort = await freePort();
  const cfg = {
    host: '127.0.0.1',
    port: deadPort,
    user: 'tester',
    pass: 'tester',
    rooms: [],
    http: { host: '127.0.0.1', port: await freePort() },
    dataDir: dir,
  };
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const child = spawn(process.execPath, [DAEMON, '--config', cfgPath], { stdio: 'ignore' });
  await sleep(WINDOW_MS);
  child.kill('SIGKILL');
  await sleep(200);

  const log = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8');
  const tries = log
    .split('\n')
    .filter((l) => l.includes('连不上') || l.includes('连接断开')).length;

  assert.ok(tries > 0, '应当至少尝试过一次重连');
  // 1s + 2s + 4s = 7s 三次，第 4 次在 15s 之后；留一点余量到 6
  assert.ok(tries <= 6, `9 秒内尝试了 ${tries} 次，疑似重连循环分裂（期望 ≤ 6）`);

  // 每一次失败只允许留下一条排期记录。
  // 旧代码 close 与 catch 各记一条，同一毫秒里成对出现——这是循环分裂的直接指纹。
  const stamps = log
    .split('\n')
    .filter((l) => l.includes('秒后重连') || l.includes('秒后重试'))
    .map((l) => (l.match(/^\[(.+?)\]/) || [])[1]);
  const duplicated = stamps.length - new Set(stamps).size;
  assert.strictEqual(duplicated, 0, '同一毫秒出现多条重连排期，close 与 catch 重复调度了');

  // 退避应当逐次翻倍
  const delays = log
    .split('\n')
    .filter((l) => l.includes('秒后重连') || l.includes('秒后重试'))
    .map((l) => Number((l.match(/，(\d+) 秒后/) || [])[1]));
  for (let i = 1; i < delays.length; i++) {
    assert.strictEqual(delays[i], Math.min(delays[i - 1] * 2, 30), '退避序列应严格翻倍');
  }
});
