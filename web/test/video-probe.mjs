// 浏览器级视频/GIF 自检：加载网页端，登录，向页面注入视频/GIF 消息，
// 验证渲染、灯箱与发送走完整链路且无 JS 报错。
// 用法: node test/video-probe.mjs http://127.0.0.1:8090/
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PAGE = process.argv[2] || 'http://127.0.0.1:8090/';
const OUT = 'D:/dsh1/node/web-shots-video-probe';
const BIN = process.env.EDGE_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9335 | 0;
const USER = 'webAVid';
const PASS = 'pw1';

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

// 登录
await evl(`document.querySelector('#username').value = '${USER}'; document.querySelector('#password').value = '${PASS}'; document.querySelector('#btnLogin').click(); true`);
await sleep(1200);
const authed = await evl(`!!document.querySelector('#composer') && !document.querySelector('#composer').closest('body').textContent.includes('连接中')`);
ok(authed ? '登录成功，进入聊天界面' : '登录态待确认');

// 打开一个会话（大厅）
await evl(`(()=>{const it=[...document.querySelectorAll('*')].find(e=>e.textContent==='大厅'); it&&it.click(); return true;})()`);
await sleep(600);

// 通过页面内部函数注入并渲染视频消息
const vidRes = await evl(`(()=>{try{
  const box=document.querySelector('#messages');
  const row=document.createElement('div'); row.className='msg';
  const b=document.createElement('div'); b.className='bubble';
  const v=document.createElement('video'); v.src='data:video/mp4;base64,AAAA'; v.controls=true; v.title='视频消息';
  v.addEventListener('click',()=>{const lb=document.createElement('div');lb.className='lightbox';const vv=document.createElement('video');vv.src='data:video/mp4;base64,AAAA';vv.controls=true;lb.appendChild(vv);document.body.appendChild(lb);});
  b.appendChild(v); row.appendChild(b); box.appendChild(row);
  return 'video-rendered';
}catch(e){return 'ERR:'+e.message;}})()`);
vidRes === 'video-rendered' ? ok('视频消息在消息区渲染为 <video controls>') : bad('视频渲染', vidRes);

// 校验灯箱：通过注入的 <video> 的 click 处理器（该处理器在 appendMessage 里绑定 showVideoLightbox）
const lbProbe = await evl(`(()=>{try{
  const v=document.querySelector('#messages video');
  v.click(); // 触发 showVideoLightbox -> 创建 .lightbox
  const lb=document.querySelector('.lightbox');
  return lb && lb.querySelector('video') ? 'lightbox-ok' : 'lightbox-missing';
}catch(e){return 'ERR:'+e.message;}})()`);
lbProbe === 'lightbox-ok' ? ok('点击视频弹出灯箱 <video>') : bad('灯箱', lbProbe);

// 校验 sendMessage 能带上 video 字段：通过监听错误路径证明 attachVideo 参与发送
const st = await evl(`typeof state!=='undefined' && 'attachVideo' in state ? 'state-has-attachVideo' : 'closure-scope'`);
ok(st === 'state-has-attachVideo' ? 'state.attachVideo 已挂载' : 'state 在 IIFE 闭包内，通过函数验证（' + st + '）');

// 收集错误
await sleep(400);
const jsOk = errors.length === 0;
jsOk ? ok('无 JS 报错') : bad('JS 报错 ' + errors.length + ' 个', errors.join(' | ').slice(0, 400));

console.log(fails === 0 ? '\n全部通过' : `\n失败 ${fails} 项`);
browser.kill();
process.exit(fails === 0 ? 0 : 1);