// 经 Cloudflare 隧道测 WebSocket 往返延迟
const HOST = process.argv[2] || '203.0.113.10';
// 网关只接受 /ws 路径的升级请求（见 gateway.js: url !== '/ws'）
const URL = process.argv[3] || `ws://${HOST}/ws`;

let seq = 0;
const pending = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ws = new WebSocket(URL);
    ws.addEventListener('open', () => resolve({ ws, handshakeMs: Date.now() - t0 }));
    ws.addEventListener('error', (e) => reject(new Error('ws error')));
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p.resolve(m); }
    });
  });
}

function request(ws, type, data) {
  return new Promise((resolve, reject) => {
    const id = `r${++seq}`;
    const t0 = process.hrtime.bigint();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 20000);
    pending.set(id, {
      resolve: (m) => { clearTimeout(timer); resolve({ msg: m, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); },
    });
    ws.send(JSON.stringify({ type, id, data: data || {} }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { ws, handshakeMs } = await connect();
  console.log(`WebSocket 握手完成: ${handshakeMs} ms`);

  const user = 'probe' + Math.random().toString(36).slice(2, 8);
  const a = await request(ws, 'auth', { username: user, password: 'probe1234' });
  console.log(`认证: ${a.ms.toFixed(0)} ms -> ${a.msg.type}`);

  const j = await request(ws, 'join', { room: 'general' }).catch((e) => ({ ms: -1, msg: { type: 'err:' + e.message } }));
  console.log(`进群: ${j.ms.toFixed(0)} ms -> ${j.msg.type}`);

  const rtts = [];
  for (let i = 0; i < 10; i++) {
    const r = await request(ws, 'who', {});
    rtts.push(r.ms);
    await sleep(120);
  }
  rtts.sort((x, y) => x - y);
  const avg = rtts.reduce((s, v) => s + v, 0) / rtts.length;
  console.log(`who RTT x10: min=${rtts[0].toFixed(0)} p50=${rtts[5].toFixed(0)} max=${rtts[9].toFixed(0)} avg=${avg.toFixed(0)} ms`);

  // 端到端投递：A 发群消息，B 收到广播（两个独立连接）
  const b = await connect();
  await request(b.ws, 'auth', { username: user + 'b', password: 'probe1234' });
  await request(b.ws, 'join', { room: 'general' });

  let t0 = 0n;
  const delivered = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20000);
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'group' && JSON.stringify(m.data).includes('probe-')) {
        clearTimeout(timer); b.ws.removeEventListener('message', h);
        resolve(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    };
    b.ws.addEventListener('message', h);
    t0 = process.hrtime.bigint();
    ws.send(JSON.stringify({ type: 'group', id: 'g' + Date.now(), data: { room: 'general', text: 'probe-' + Date.now() } }));
  });
  console.log(`A→B 群消息投递: ${delivered === null ? '未收到广播' : delivered.toFixed(0) + ' ms'}`);

  b.ws.close();
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
