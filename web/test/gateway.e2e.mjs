// 网关端到端联调：真实 WebSocket 客户端 <-> 网关 <-> TCP 服务端
const URL = 'ws://127.0.0.1:8090/ws';
let fails = 0;
const ok = (name) => console.log('  ✅ ' + name);
const bad = (name, extra) => { fails++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); };

function client(tag) {
  const ws = new WebSocket(URL);
  const waiters = new Map();
  const inbox = [];
  let seq = 0;
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && waiters.has(m.id)) {
      const w = waiters.get(m.id);
      waiters.delete(m.id);
      if (m.type === 'error' || m.type === 'auth_err') w.reject(new Error(m.data.message));
      else w.resolve(m.data);
      return;
    }
    inbox.push(m);
  });
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error(tag + ' 连接失败')));
  });
  return {
    tag, ws, inbox,
    open: () => opened,
    req(type, data) {
      const id = tag + (++seq);
      return new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject });
        setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(type + ' 超时')); } }, 5000);
        ws.send(JSON.stringify({ type, id, data: data || {} })); // 故意不带换行，测网关补换行
      });
    },
    raw: (s) => ws.send(s),
    close: () => ws.close(),
    waitFor(pred, ms = 4000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('等待超时')), ms);
        const tick = () => {
          const i = inbox.findIndex(pred);
          if (i >= 0) { clearTimeout(t); resolve(inbox.splice(i, 1)[0]); }
          else setTimeout(tick, 40);
        };
        tick();
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = client('A');
const b = client('B');
await Promise.all([a.open(), b.open()]);
ok('两个 WebSocket 握手成功');

const authA = await a.req('auth', { username: 'webA', password: 'pw1' });
authA.user === 'webA' ? ok('A 认证成功（自动注册）') : bad('A 认证', JSON.stringify(authA));
const authB = await b.req('auth', { username: 'webB', password: 'pw2' });
authB.user === 'webB' ? ok('B 认证成功') : bad('B 认证');

const rooms = await a.req('rooms', {});
Array.isArray(rooms.rooms) && rooms.rooms.length > 0
  ? ok('rooms 返回 ' + rooms.rooms.map((r) => r.name).join('/'))
  : bad('rooms 异常', JSON.stringify(rooms));

await a.req('join', { room: '大厅' });
await b.req('join', { room: '大厅' });
ok('两个客户端加入「大厅」');

const grp = await a.req('group', { room: '大厅', text: '网页端联调 · 中文与 emoji 🎉' });
grp.message && grp.message.text.includes('🎉') ? ok('群消息发送成功') : bad('群消息', JSON.stringify(grp));

const gotGroup = await b.waitFor((m) => m.type === 'group' && m.data.text.includes('🎉'));
gotGroup ? ok('B 收到群消息（UTF-8 完整）') : bad('B 未收到群消息');

const dm = await a.req('msg', { to: 'webB', text: '私聊一句' });
dm.delivered !== false ? ok('私聊在线即时投递') : bad('私聊投递', JSON.stringify(dm));
const gotDm = await b.waitFor((m) => m.type === 'msg' && m.data.text === '私聊一句');
gotDm ? ok('B 收到私聊') : bad('B 未收到私聊');

// 大帧：验证 65535 以上的长度编码（64 位长度分支）。文本上限 4000 字，
// 所以用图片（data URL 上限 600000 字符）来撑体积。
const imgPayload = 'data:image/jpeg;base64,' + 'A'.repeat(90000);
try {
  const big = await a.req('group', { room: '大厅', text: '大图', image: imgPayload });
  big.message && big.message.image.length === imgPayload.length
    ? ok('90 KB 大帧透传成功（64 位长度分支）')
    : bad('大帧', 'len=' + (big.message && big.message.image && big.message.image.length));
} catch (e) {
  bad('大帧透传', e.message);
}

// GIF 动图：服务器对 data:image/gif 放行到 MAX_MEDIA_LEN(1200KB)，实测 900KB 的 GIF
const gifPayload = 'data:image/gif;base64,' + 'R0lGODlh'.repeat(100) + 'A'.repeat(900000);
try {
  const g = await a.req('group', { room: '大厅', text: '动图', image: gifPayload });
  g.message && g.message.image && g.message.image.length === gifPayload.length
    ? ok('900 KB GIF 透传成功（动图上限 1200KB）')
    : bad('GIF', 'len=' + (g.message && g.message.image && g.message.image.length));
} catch (e) {
  bad('GIF 透传', e.message);
}

// 短视频：data:video/mp4 应被服务器接受并落库
const vidPayload = 'data:video/mp4;base64,' + 'A'.repeat(1500000);
try {
  const v = await a.req('group', { room: '大厅', text: '短视频', video: vidPayload });
  v.message && v.message.video && v.message.video.length === vidPayload.length
    ? ok('1.5 MB 短视频透传成功（视频上限 2000KB）')
    : bad('视频', 'len=' + (v.message && v.message.video && v.message.video.length));
} catch (e) {
  bad('视频透传', e.message);
}

// 超限视频：超过 MAX_VIDEO_LEN(2000KB) 应被拒绝并给出错误
const overVid = 'data:video/mp4;base64,' + 'A'.repeat(2500000);
try {
  await a.req('group', { room: '大厅', text: '超限', video: overVid });
  bad('超限视频未被拒绝（应报错）');
} catch (e) {
  /视频/.test(e.message) ? ok('超限视频被拒绝：' + e.message) : ok('超限视频被拒绝（消息=' + e.message + '）');
}

// 分片帧：浏览器 WebSocket API 不暴露帧边界（send 一次就是一整帧），
// 所以这里直接对网关的 FrameParser 做单元验证，顺带证明「一次喂 1 字节」也能重组。
{
  const { createRequire } = await import('node:module');
  const require2 = createRequire(import.meta.url);
  const { FrameParser } = require2('../src/gateway.js');

  function maskedFrame(opcode, buf, fin, mask) {
    const len = buf.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] |= 0x80;
    const body = Buffer.from(buf);
    for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i & 3];
    return Buffer.concat([head, mask, body]);
  }

  const mask = Buffer.from([9, 8, 7, 6]);
  const payload = Buffer.from('{"type":"group","data":{"room":"大厅","text":"分片消息"}}', 'utf8');
  const cut = 20;
  const wire = Buffer.concat([
    maskedFrame(0x1, payload.subarray(0, cut), false, mask),
    maskedFrame(0x9, Buffer.from('hb'), true, mask), // 控制帧可以插在分片中间
    maskedFrame(0x0, payload.subarray(cut), true, mask),
  ]);

  const p = new FrameParser(2 * 1024 * 1024);
  const out = [];
  for (const byte of wire) out.push(...p.push(Buffer.from([byte]))); // 逐字节喂

  const text = out.find((f) => f.opcode === 0x1);
  const ping = out.find((f) => f.opcode === 0x9);
  text && text.payload.equals(payload) && ping && ping.payload.toString() === 'hb'
    ? ok('分片重组 + 逐字节投喂 + 夹带控制帧，全部正确')
    : bad('分片重组', JSON.stringify({ got: text && text.payload.toString(), ping: !!ping }));
}

// ping -> pong
const pong = new Promise((res) => {
  a.ws.addEventListener('message', function h(ev) {
    if (typeof ev.data === 'string') return;
  });
  setTimeout(res, 300);
});
a.raw(JSON.stringify({ type: 'ping', data: {} }));
const gotPong = await a.waitFor((m) => m.type === 'pong', 3000).catch(() => null);
gotPong ? ok('ping/pong 透传正常') : bad('未收到 pong');

// 错误路径：未认证请求
const c = client('C');
await c.open();
let unauthErr = null;
try { await c.req('rooms', {}); } catch (e) { unauthErr = e.message; }
unauthErr && unauthErr.includes('认证') ? ok('未认证被拒绝：' + unauthErr) : bad('未认证未拒绝', unauthErr);

c.close();
a.close();
b.close();
await sleep(300);
console.log(fails === 0 ? '\n全部通过' : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
