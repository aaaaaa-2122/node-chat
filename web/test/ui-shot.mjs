// 用 Chrome/Edge 的 DevTools 协议给网页端截图（本地开发自检用）
//
//   node test/ui-shot.mjs [页面地址] [输出目录]
//
// 流程：截登录页 -> 填表登录 -> 打开群聊并发一条消息 -> 截桌面图 -> 截手机图。
// 浏览器路径用环境变量 EDGE_BIN 覆盖。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PAGE = process.argv[2] || 'http://127.0.0.1:8090/';
const OUT = process.argv[3] || 'D:/dsh1/node/web-shots';
const BIN = process.env.EDGE_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const ROOM = process.env.ROOM || '大厅';
const USER = process.env.USER_NAME || 'webA';
const PASS = process.env.USER_PASS || 'pw1';

mkdirSync(OUT, { recursive: true });
try {
  rmSync(`${OUT}/_profile`, { recursive: true, force: true });
} catch (_) {}

// 有些环境（CI/沙箱）只给 HTTP 代理出网，浏览器默认不走代理，这里带上
const PROXY =
  process.env.BROWSER_PROXY ||
  (/^http:\/\/(127\.0\.0\.1|localhost)/.test(PAGE) ? '' : process.env.HTTP_PROXY || process.env.http_proxy || '');

const browser = spawn(BIN, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  // 每次用独立 profile：复用同一目录时 Edge 会挂到旧实例上，
  // 导致上一轮页面还在跑、消息被重复发送
  `--user-data-dir=${OUT}/_profile-${process.pid}`,
  ...(PROXY ? [`--proxy-server=${PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost'] : []),
  'about:blank',
], { stdio: 'ignore' });
if (PROXY) console.log('浏览器走代理：' + PROXY);

async function wsTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('连不上 DevTools');
}

const url = await wsTarget();
const ws = new WebSocket(url);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
});

let seq = 0;
const waiters = new Map();
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiters.has(m.id)) {
    const w = waiters.get(m.id);
    waiters.delete(m.id);
    if (m.error) w.reject(new Error(m.error.message));
    else w.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  }
});

function cdp(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

const evalJs = async (expression) => {
  const r = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const p = `${OUT}/${name}.png`;
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('截图 ' + p);
};

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url: PAGE });

// 等页面真的就绪（公网首次连接可能比本地慢很多）
const ready = await evalJs(`
  (async () => {
    for (let i = 0; i < 200; i++) {
      if (document.readyState === 'complete' && document.querySelector('#inputUser')) {
        return 'ok:' + location.href;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return 'timeout readyState=' + document.readyState + ' url=' + location.href +
      ' title=' + document.title + ' hasForm=' + !!document.querySelector('#loginForm');
  })()
`);
console.log('页面就绪：' + ready);
if (!String(ready).startsWith('ok')) {
  await shot('00-not-ready');
  browser.kill();
  process.exit(1);
}
await sleep(400);
await shot('01-login');

const loginResult = await evalJs(`
  (async () => {
    document.querySelector('#inputUser').value = ${JSON.stringify(USER)};
    document.querySelector('#inputPass').value = ${JSON.stringify(PASS)};
    document.querySelector('#btnLogin').click();
    for (let i = 0; i < 60; i++) {
      if (!document.querySelector('#app').hidden) return 'ok';
      await new Promise(r => setTimeout(r, 100));
    }
    const err = document.querySelector('#loginErr');
    return 'fail: ' + (err ? err.textContent : '未知');
  })()
`);
console.log('登录结果：' + loginResult);
if (loginResult !== 'ok') {
  await shot('01b-login-fail');
  browser.kill();
  process.exit(1);
}

await sleep(600);

// ---------------------------------------------------------------- 陪聊账号
// 另开一条 WebSocket 当「别人」，这样群里能看到对方消息、私聊列表也有人
const BUDDY = process.env.BUDDY || 'webB';
const buddyUrl = new URL(PAGE);
buddyUrl.protocol = buddyUrl.protocol === 'https:' ? 'wss:' : 'ws:';
buddyUrl.pathname = '/ws';
const buddy = new WebSocket(buddyUrl.toString());
await new Promise((res, rej) => {
  buddy.addEventListener('open', res);
  buddy.addEventListener('error', () => rej(new Error('陪聊账号连不上')));
});

const buddyReq = (type, data) => new Promise((resolve) => {
  const id = 'b' + Math.random().toString(36).slice(2, 8);
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === id) {
      buddy.removeEventListener('message', onMsg);
      resolve(m.data);
    }
  };
  buddy.addEventListener('message', onMsg);
  buddy.send(JSON.stringify({ type, id, data: data || {} }));
});

await buddyReq('auth', { username: BUDDY, password: 'pw2' });
await buddyReq('join', { room: ROOM });
await buddyReq('group', { room: ROOM, text: '我是 webB，从另一个浏览器发来的 👋' });
await buddyReq('msg', { to: USER, text: '私聊消息收到了吗？' });
console.log('陪聊账号已就绪：' + BUDDY);
await sleep(500);

// 打开群聊并说一句话
const talk = await evalJs(`
  (async () => {
    const room = [...document.querySelectorAll('.conv[data-kind="room"]')]
      .find(el => el.dataset.id === ${JSON.stringify(ROOM)});
    if (!room) return 'no room';
    room.click();
    await new Promise(r => setTimeout(r, 900));
    const box = document.querySelector('#input');
    box.value = '网页端上线了，这是从浏览器发出来的第一条消息 🎉';
    box.dispatchEvent(new Event('input'));
    document.querySelector('#btnSend').click();
    await new Promise(r => setTimeout(r, 900));
    return document.querySelectorAll('.msg').length + ' 条消息';
  })()
`);
console.log('发送结果：' + talk);
// 图片消息：造一张 2400x1400 的图丢进 file input，验证前端压缩 + 发送
const imgResult = await evalJs(`
  (async () => {
    async function makeFile(w, h) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#4f46e5'); g.addColorStop(.55, '#7c3aed'); g.addColorStop(1, '#06b6d4');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.font = 'bold ' + Math.round(h / 4) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('图片消息', w / 2, h / 2);
      const blob = await new Promise(r => c.toBlob(r, 'image/png', 0.95));
      return new File([blob], 'shot.png', { type: 'image/png' });
    }
    const dt = new DataTransfer();
    dt.items.add(await makeFile(2400, 1400));
    const input = document.querySelector('#fileImage');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    const t0 = Date.now();
    while (document.querySelector('#attach').hidden && Date.now() - t0 < 8000) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (document.querySelector('#attach').hidden) return '预览没出来';
    const src = document.querySelector('#attachImg').src;
    document.querySelector('#input').value = '压过的图，原始 2400×1400';
    document.querySelector('#btnSend').click();
    await new Promise(r => setTimeout(r, 1200));
    return 'dataUrl ' + Math.round(src.length / 1024) + ' KB';
  })()
`);
console.log('图片消息：' + imgResult);

// 换头像
const avResult = await evalJs(`
  (async () => {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 512, 512);
    g.addColorStop(0, '#f59e0b'); g.addColorStop(1, '#ef4444');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 240px sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('A', 256, 340);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'avatar.png', { type: 'image/png' }));
    const input = document.querySelector('#fileAvatar');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1200));
    const style = getComputedStyle(document.querySelector('#meAvatar')).backgroundImage;
    return style && style !== 'none' ? '头像已更新' : '头像没生效';
  })()
`);
console.log('头像：' + avResult);

await shot('02-chat');

// ---------------------------------------------------------------- 一段正常对话（给 README 用）
// 换到另一个空群，避免截图里塞着上面的测试图片
const HERO_ROOM = process.env.HERO_ROOM || 'dev';
await buddyReq('join', { room: HERO_ROOM });
await evalJs(`
  (async () => {
    const el = [...document.querySelectorAll('.conv[data-kind="room"]')]
      .find(n => n.dataset.id === ${JSON.stringify(HERO_ROOM)});
    if (el) el.click();
    await new Promise(r => setTimeout(r, 900));
    return 'ok';
  })()
`);
const say = (text) => evalJs(`
  (async () => {
    // 清掉可能还挂着的附件，别把上一张图带进新消息
    const x = document.querySelector('#btnAttachClear');
    if (x && !document.querySelector('#attach').hidden) x.click();
    const box = document.querySelector('#input');
    box.value = ${JSON.stringify(text)};
    document.querySelector('#btnSend').click();
    await new Promise(r => setTimeout(r, 500));
    return 'ok';
  })()
`);
await say('在吗？网页端刚跑通');
await buddyReq('group', { room: HERO_ROOM, text: '在，我在另一个浏览器里能看到' });
await sleep(400);
await say('图片、头像、历史都能用，刷新还会回到上次的会话');
await buddyReq('group', { room: HERO_ROOM, text: '桌面端和手机连的还是同一台服务器吧' });
await sleep(400);
await say('对，同一套 TCP + NDJSON，网页这边只是加了个 WebSocket 网关');
await sleep(600);
await shot('05-hero');


// 私聊
await evalJs(`
  (async () => {
    const dm = document.querySelector('.conv[data-kind="dm"]');
    if (dm) dm.click();
    await new Promise(r => setTimeout(r, 700));
    const box = document.querySelector('#input');
    box.value = '私聊也通';
    document.querySelector('#btnSend').click();
    await new Promise(r => setTimeout(r, 700));
    return 'ok';
  })()
`);
await shot('03-dm');

// 手机视口
await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
await sleep(500);
await shot('04-mobile');

console.log(consoleErrors.length ? '页面报错:\n  ' + consoleErrors.join('\n  ') : '无 JS 报错');
try {
  await cdp('Browser.close');
} catch (_) {}
browser.kill();
process.exit(0);
