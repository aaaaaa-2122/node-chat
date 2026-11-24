// 浏览器级邮箱验证登录自检：加载网页端，走注册 -> 验证码区 -> 验证 -> 进聊天
// 用法: node test/email-probe.mjs http://127.0.0.1:8081/ [code]
//   无 code: 注册新用户，验证验证码区出现 + 无 JS 报错
//   有 code: 填码确认验证，验证进入聊天界面
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PAGE = process.argv[2] || 'http://127.0.0.1:8081/';
const CODE = process.argv[3] || '';
const OUT = 'D:/dsh1/node/web-shots-email-probe';
const BIN = process.env.EDGE_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9340;
const U = 'emailProbeUser';

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
const ok = (n) => { console.log('  OK ' + n); };
const bad = (n, e) => { fails++; console.log('  FAIL ' + n + (e ? '  ' + e : '')); };

await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Page.navigate', { url: PAGE });
await sleep(1500);

const hasFields = await evl(`!!document.querySelector('#inputEmail') && !!document.querySelector('#btnRegister') && !!document.querySelector('#btnLogin')`);
hasFields ? ok('登录卡含邮箱输入 + 注册/登录按钮') : bad('登录卡元素', '缺邮箱或按钮');

if (CODE) {
  // 验证阶段：模拟「已注册收到码」，直接显示验证码区并填码验证
  await evl(`document.querySelector('#inputUser').value='${U}'; document.querySelector('#verifySection').hidden=false; document.querySelector('#inputVerify').value='${CODE}'; document.querySelector('#btnVerify').click(); true`);
  await sleep(1800);
  const inChat = await evl(`!document.querySelector('#app').hidden`);
  if (inChat) {
    ok('填码验证后进入聊天界面');
  } else {
    const errText = await evl(`document.querySelector('#loginErr') && document.querySelector('#loginErr').textContent`);
    const verifyHidden = await evl(`document.querySelector('#verifySection').hidden`);
    bad('进入聊天', 'app 仍隐藏, loginErr="' + errText + '", verifySection.hidden=' + verifyHidden);
  }
} else {
  // 注册阶段：填注册表单，点注册，验证码区出现
  await evl(`document.querySelector('#inputUser').value='${U}'; document.querySelector('#inputPass').value='pw1'; document.querySelector('#inputEmail').value='${U}@demo.com'; document.querySelector('#btnRegister').click(); true`);
  await sleep(1800);
  const verifyShown = await evl(`!document.querySelector('#verifySection').hidden`);
  verifyShown ? ok('点注册后验证码区出现') : bad('验证码区', '未出现');
  console.log('  [提示] 注册已受理，验证码在服务端日志。可用 code 参数跑验证阶段。');
}

await sleep(300);
const jsOk = errors.length === 0;
jsOk ? ok('无 JS 报错') : bad('JS 报错 ' + errors.length + ' 个', errors.join(' | ').slice(0, 300));

console.log(fails === 0 ? '\n全部通过' : `\n失败 ${fails} 项`);
browser.kill();
process.exit(fails === 0 ? 0 : 1);