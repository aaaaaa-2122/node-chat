// 经 WebSocket 测端到端投递延迟
//
// 用法：
//   node cf-latency.mjs                          # 默认测本机 80 端口（明文）
//   node cf-latency.mjs <host>                   # 测指定主机
//   node cf-latency.mjs <host> <ws-url>          # 指定完整地址（如 wss://x/ws）
//
// 默认用两条连接互发**私信**测投递耗时，不写任何真实房间——早期版本往 #general
// 发 probe- 消息，会污染线上房间，已改。私信与群消息在服务端走同一条广播链路，
// 延迟数值等价。
//
// 跑完会留下若干 probe 开头的测试账号（私信记录随之），清理：
//   python3 tools/clean-probe.py   （在服务器上以 root 执行，需先停 node-chat）

const HOST = process.argv[2] || '111.230.141.216';
// 网关只接受 /ws 路径的升级请求（gateway.js: url !== '/ws' 即 400）
const URL = process.argv[3] || `ws://${HOST}/ws`;

let seq = 0;
const pending = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ws = new WebSocket(URL);
    ws.addEventListener('open', () => resolve({ ws, handshakeMs: Date.now() - t0 }));
    ws.addEventListener('error', () => reject(new Error('ws error')));
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
  const a = await connect();
  console.log(`WebSocket 握手完成: ${a.handshakeMs} ms`);

  const tag = Math.random().toString(36).slice(2, 8);
  const userA = 'probea' + tag;
  const userB = 'probeb' + tag;

  const ra = await request(a.ws, 'auth', { username: userA, password: 'probe1234' });
  console.log(`A 认证: ${ra.ms.toFixed(0)} ms -> ${ra.msg.type}`);
  await sleep(100);

  const b = await connect();
  const rb = await request(b.ws, 'auth', { username: userB, password: 'probe1234' });
  console.log(`B 认证: ${rb.ms.toFixed(0)} ms -> ${rb.msg.type}`);
  await sleep(200);

  const rtts = [];
  for (let i = 0; i < 10; i++) {
    const r = await request(a.ws, 'who', {});
    rtts.push(r.ms);
    await sleep(120);
  }
  rtts.sort((x, y) => x - y);
  const avg = rtts.reduce((s, v) => s + v, 0) / rtts.length;
  console.log(`who RTT x10: min=${rtts[0].toFixed(0)} p50=${rtts[5].toFixed(0)} max=${rtts[9].toFixed(0)} avg=${avg.toFixed(0)} ms`);

  // A -> B 私信，量 B 收到广播的时间
  let t0 = 0n;
  const delivered = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20000);
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type !== 'msg') return;
      if (!JSON.stringify(m.data).includes('probe-')) return;
      clearTimeout(timer);
      b.ws.removeEventListener('message', h);
      resolve(Number(process.hrtime.bigint() - t0) / 1e6);
    };
    b.ws.addEventListener('message', h);
    t0 = process.hrtime.bigint();
    a.ws.send(JSON.stringify({ type: 'msg', id: 'm' + Date.now(), data: { to: userB, text: 'probe-' + Date.now() } }));
  });
  console.log(`A→B 私信投递: ${delivered === null ? '未收到广播' : delivered.toFixed(0) + ' ms'}`);

  b.ws.close();
  a.ws.close();
  process.exit(delivered === null ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
