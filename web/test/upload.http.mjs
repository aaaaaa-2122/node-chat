import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const HOST = '127.0.0.1';
const PORT = 8080;
const filePath = 'tmp/fakevideo.mp4';

// 自包含：不存在则生成 10MB 假视频
if (!fs.existsSync(filePath)) {
  const mk = Buffer.alloc(10 * 1024 * 1024);
  for (let i = 0; i < mk.length; i += 1) mk[i] = (i * 7) % 256;
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync(filePath, mk);
}

function uploadChunk(name, chunk, total, data) {
  return new Promise((resolve, reject) => {
    const q = `/upload?name=${encodeURIComponent(name)}&chunk=${chunk}&total=${total}`;
    const req = http.request({ host: HOST, port: PORT, path: q, method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getUrl(urlPath, range) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (range) headers['Range'] = range;
    const req = http.request({ host: HOST, port: PORT, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks),
        contentRange: res.headers['content-range'], acceptRanges: res.headers['accept-ranges'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

const src = fs.readFileSync(filePath);
const size = src.length;
const total = Math.max(1, Math.ceil(size / (4 * 1024 * 1024)));
const srcHash = crypto.createHash('sha1').update(src).digest('hex');
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✔', name); } else { fail++; console.log('  ✘ FAIL:', name); } };

console.log('== 1. 分块上传 ==');
let finalUrl = null;
for (let i = 0; i < total; i++) {
  const slice = src.subarray(i * (4 * 1024 * 1024), Math.min(size, (i + 1) * (4 * 1024 * 1024)));
  const r = await uploadChunk('fakevideo.mp4', i, total, slice);
  check(`chunk ${i} 200 ok=true`, r.status === 200 && r.json && r.json.ok === true);
  if (r.json && r.json.url) finalUrl = r.json.url;
}
check('返回最终 URL', !!finalUrl);

console.log('\n== 2. 上传完成后临时分块已清理 ==');
const parts = fs.readdirSync('uploads').filter((e) => e.endsWith('.part'));
check('uploads 无 .part 残留（合并后已清理）', parts.length === 0);
console.log('   uploads:', fs.readdirSync('uploads'));

console.log('\n== 3. 完整下载 + 完整性 ==');
const full = await getUrl(finalUrl);
check(`full GET 200 且 size 正确`, full.status === 200 && full.body.length === size);
check('文件内容 hash 与源一致', crypto.createHash('sha1').update(full.body).digest('hex') === srcHash);

console.log('\n== 4. HTTP Range ==');
const part = await getUrl(finalUrl, 'bytes=1048576-2097151');
check('range 中间 1MB -> 206', part.status === 206);
check('range 内容匹配', part.body.equals(src.subarray(1048576, 2097152)));
check('content-range 正确', part.contentRange === `bytes 1048576-2097151/${size}`);
const suffix = await getUrl(finalUrl, 'bytes=-524288');
check('suffix 末 512KB -> 206 且匹配', suffix.status === 206 && suffix.body.equals(src.subarray(size - 524288)));

console.log('\n== 5. 安全边界 ==');
check('坏 range -> 416', (await getUrl(finalUrl, 'bytes=99999999999-')).status === 416);
check('目录穿越 -> 404', (await getUrl('/files/..%2f..%2fsecret.txt')).status === 404);
// 格式不限：.exe 这类只允许下载的放行；会当页面/脚本执行的（.html/.svg/.js）才拒绝
check('exe 允许上传（只给下载）', (await uploadChunk('setup.exe', 0, 1, Buffer.from('MZ'))).status === 200);
check('html 被拒绝 -> 400', (await uploadChunk('evil.html', 0, 1, Buffer.from('<b>'))).status === 400);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);