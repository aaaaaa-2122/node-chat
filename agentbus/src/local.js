'use strict';

/** 本地接口的极简客户端（http，无依赖）—— watchdog 和 agentbus CLI 共用 */

const fs = require('fs');
const path = require('path');
const http = require('http');

function tokenFor(cfg) {
  const p = path.join(cfg.dataDir, 'token');
  if (!fs.existsSync(p)) {
    const err = new Error('找不到 token：' + p + '（守护进程还没起来？）');
    err.code = 'no_daemon';
    throw err;
  }
  return fs.readFileSync(p, 'utf8').trim();
}

function call(cfg, method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const token = tokenFor(cfg);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'x-agentbus-token': token };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        host: cfg.http.host,
        port: cfg.http.port,
        path: urlPath,
        method: method,
        headers: headers,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(buf);
          } catch (e) {
            return reject(new Error('本地接口返回了非 JSON：' + buf.slice(0, 120)));
          }
          if (res.statusCode >= 400) {
            const err = new Error(data.error || '本地接口错误 ' + res.statusCode);
            err.status = res.statusCode;
            err.body = data;
            return reject(err);
          }
          resolve(data);
        });
      }
    );

    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        err.code = 'no_daemon';
        err.message = '守护进程没在跑（' + cfg.http.host + ':' + cfg.http.port + ' 拒绝连接）';
      }
      reject(err);
    });

    req.setTimeout(timeoutMs || 15000, () => {
      req.destroy(new Error('本地接口超时'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { call, tokenFor };
