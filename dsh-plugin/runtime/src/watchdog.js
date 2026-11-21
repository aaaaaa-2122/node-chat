'use strict';

/**
 * watchdog —— 一次性的「等一条唤醒消息」。
 *
 * 它不持有 TCP 连接，只对守护进程做长轮询，所以可以随时退出，
 * 退出本身就是要给宿主的信号（后台任务完成 → 通知 → 新 turn）。
 *
 * 输出：stdout 一行 JSON
 *   {"ok":true,"wake":[...],"backlog":{...},"cursor":...}
 *
 * 退出码（宿主只看这个就够决定下一步）：
 *   0  有唤醒消息（stdout 里有）
 *   1  守护进程不在 / 本地接口出错
 *   2  配置错误
 *   4  等到超时也没有唤醒消息
 *   5  有消息但读取失败（罕见）
 */

const path = require('path');
const { loadConfig } = require('./daemon');
const { call } = require('./local');

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };

  const cfgPath = getArg('--config', path.join(__dirname, '..', 'config.json'));
  let cfg;
  try {
    cfg = loadConfig(cfgPath);
  } catch (e) {
    process.stderr.write('配置错误：' + e.message + '\n');
    process.exit(2);
  }

  const wait = Math.max(1, parseInt(getArg('--wait', '300'), 10) || 300);
  const since = parseInt(getArg('--since', '0'), 10) || 0;

  try {
    const d = await call(cfg, 'GET', '/inbox/next?wait=' + wait + '&since=' + since, null, (wait + 15) * 1000);

    if (d.wake && d.wake.length) {
      process.stdout.write(JSON.stringify({ ok: true, wake: d.wake, backlog: d.backlog, cursor: d.cursor }) + '\n');
      process.exit(0);
    }

    // 超时无信：正常的一次「空守」，宿主重挂即可
    process.stdout.write(
      JSON.stringify({ ok: true, wake: [], timeout: true, backlog: d.backlog, cursor: d.cursor }) + '\n'
    );
    process.exit(4);
  } catch (e) {
    const code = e.code === 'no_daemon' ? 1 : 5;
    process.stderr.write('watchdog 失败：' + e.message + '\n');
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, code: e.code || 'error' }) + '\n');
    process.exit(code);
  }
}

main();
