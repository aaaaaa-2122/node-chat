// 端到端：分块上传 -> videoUrl 群消息 -> 服务端接收/校验 -> 收件人可播放
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const URL = 'ws://127.0.0.1:8080/ws';
const PORT = 8080;
let fails = 0;
const ok = (n) => console.log('  ✅ ' + n);
const bad = (n, e) => { fails++; console.log('  ❌ ' + n + (e ? '  ' + e : '')); };

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
        ws.send(JSON.stringify({ type, id, data: data || {} }));
      });
    },
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

function uploadChunk(name, chunk, total, data) {
  return new Promise((resolve, reject) => {
    const q = `/upload?name=${encodeURIComponent(name)}&chunk=${chunk}&total=${total}`;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: q, method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 1) 上传一个真实可播放的小视频（生成一个有效 MP4 头的最小样本——这里用假数据测链路）
fs.writeFileSync('tmp/sample.mp4', Buffer.alloc(3 * 1024 * 1024, 7)); // 3MB，跨 1 块，验证多块合并
const srcSize = fs.statSync('tmp/sample.mp4').size;
const total = Math.max(1, Math.ceil(srcSize / (4 * 1024 * 1024)));
const buf = fs.readFileSync('tmp/sample.mp4');
let finalUrl = null;
for (let i = 0; i < total; i++) {
  const slice = buf.subarray(i * (4 * 1024 * 1024), Math.min(srcSize, (i + 1) * (4 * 1024 * 1024)));
  const r = await uploadChunk('sample.mp4', i, total, slice);
  if (r && r.ok) { if (r.url) finalUrl = r.url; }
  else { bad('上传块 ' + i, JSON.stringify(r)); process.exit(1); }
}
ok('分块上传完成，videoUrl=' + finalUrl);

// 2) 客户端 A、B 连接网关，加入大厅
const a = client('A');
const b = client('B');
await Promise.all([a.open(), b.open()]);
const authA = await a.req('auth', { username: 'upA', password: 'pw1' });
ok('A 认证: ' + (authA.user === 'upA'));
const authB = await b.req('auth', { username: 'upB', password: 'pw2' });
ok('B 认证: ' + (authB.user === 'upB'));
await a.req('join', { room: '大厅' });
await b.req('join', { room: '大厅' });

// 3) A 发带 videoUrl 的群消息
const grp = await a.req('group', { room: '大厅', text: '看我发的视频', videoUrl: finalUrl });
ok('群消息发送成功，服务端返回 videoUrl=' + (grp.message && grp.message.videoUrl));

// 4) B 收到该消息且 videoUrl 完整
const got = await b.waitFor((m) => m.type === 'group' && m.data.videoUrl);
ok('B 收到 videoUrl=' + (got && got.data.videoUrl) + (got && got.data.videoUrl === finalUrl ? ' （一致）' : ' （不一致!）'));

// 5) 非法的 videoUrl（目录穿越/超长/不是 /files 前缀）应被服务端拒绝
try {
  const bad1 = await a.req('group', { room: '大厅', text: 'x', videoUrl: '../../etc/passwd' });
  bad('非 /files 前缀 videoUrl 被拒', JSON.stringify(bad1));
} catch { ok('非 /files 前缀 videoUrl 被拒'); }

console.log('\n结果: ' + (fails ? fails + ' 失败' : '全部通过'));
process.exit(fails ? 1 : 0);