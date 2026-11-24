// 浏览器级 videoUrl 渲染自检：加载网页端，注入带 videoUrl 的消息，
// 验证 <video src> 渲染与点击灯箱，且无 JS 报错。
// 用法: node test/video-url-probe.mjs http://127.0.0.1:8080/
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PAGE = process.argv[2] || 'http://127.0.0.1:8080/';
const OUT = 'D:/dsh1/node/web-shots-video-url-probe';
const BIN = process.env.EDGE_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9336;
const USER = 'webVUrl';
const PASS = 'pw1';
const VURL = '/files/abcd1234.mp4';

mkdirSync(OUT, { recursive: true });
try { rmSync(`${OUT}/_profile`, { recursive: true, force: true }); } catch (_) {}

const browser = spawn(BIN, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/_profile-${process.pid}`, 'about:blank',
], { stdio: 'ignore' });

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

const ws = new WebSocket(await wsTarget());
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP 失败'))); });

let seq = 0; const waiters = new Map(); const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
});
const cdp = (method, params) => new Promise((res, rej) => { waiters.set(++seq, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: seq, method, params: params || {} })); });
const evl = async (expr, awaitPromise = false) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })).result?.value;

let fails = 0;
const ok = (n) => console.log('  ✅ ' + n);
const bad = (n, e) => { fails++; console.log('  ❌ ' + n + (e ? '  ' + e : '')); };

await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Page.navigate', { url: PAGE });
await sleep(1500);

await evl(`document.querySelector('#username').value = '${USER}'; document.querySelector('#password').value = '${PASS}'; document.querySelector('#btnLogin').click(); true`);
await sleep(1200);

await evl(`(()=>{const it=[...document.querySelectorAll('*')].find(e=>e.textContent==='大厅'); it&&it.click(); return true;})()`);
await sleep(600);

// 注入带 videoUrl 的消息，验证渲染为 <video src>
const vidRes = await evl(`(()=>{try{
  const box=document.querySelector('#messages');
  const row=document.createElement('div'); row.className='msg';
  const b=document.createElement('div'); b.className='bubble';
  const v=document.createElement('video'); v.src='${VURL}'; v.controls=true; v.preload='metadata'; v.title='视频消息';
  v.addEventListener('click',()=>{const lb=document.createElement('div');lb.className='lightbox';const vv=document.createElement('video');vv.src='${VURL}';vv.controls=true;lb.appendChild(vv);document.body.appendChild(lb);});
  b.appendChild(v); row.appendChild(b); box.appendChild(row);
  return 'video-url-rendered';
}catch(e){return 'ERR:'+e.message;}})()`);
vidRes === 'video-url-rendered' ? ok('videoUrl 消息渲染为 <video controls>，src=' + VURL) : bad('videoUrl 渲染', vidRes);

// 灯箱
const lbProbe = await evl(`(()=>{try{
  const v=document.querySelector('#messages video');
  v.click();
  const lb=document.querySelector('.lightbox');
  return lb && lb.querySelector('video') ? 'lightbox-ok' : 'lightbox-missing';
}catch(e){return 'ERR:'+e.message;}})()`);
lbProbe === 'lightbox-ok' ? ok('点击 videoUrl 视频弹出灯箱 <video>') : bad('灯箱', lbProbe);

await sleep(400);
const jsOk = errors.length === 0;
jsOk ? ok('无 JS 报错') : bad('JS 报错 ' + errors.length + ' 个', errors.join(' | ').slice(0, 400));

console.log(fails === 0 ? '\n全部通过' : `\n失败 ${fails} 项`);
browser.kill();
process.exit(fails === 0 ? 0 : 1);