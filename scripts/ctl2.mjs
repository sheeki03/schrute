import http from 'node:http';
import fs from 'node:fs';
const [,, method = 'GET', path = '/ctl/status', bodyFile] = process.argv;
const body = bodyFile ? JSON.parse(fs.readFileSync(bodyFile, 'utf-8')) : undefined;
const start = Date.now();
const req = http.request({ socketPath: '/Users/home/.schrute/daemon.sock', path, method, headers: { 'Content-Type': 'application/json' } }, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => { console.log(`${Date.now()-start}ms`, d); process.exit(0); });
});
req.setTimeout(30000, () => { console.error('timeout'); process.exit(1); });
req.on('error', e => { console.error(e.message); process.exit(1); });
if (body) req.write(JSON.stringify(body));
req.end();
