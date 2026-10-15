const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
const api = spawn(process.execPath, [path.join(root, 'server/index.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
children.push(api);
api.on('exit', (code) => {
  if (!stopping) stop(code || 1);
});
function wait(attempt = 0) {
  if (stopping) return;
  const req = http.get('http://127.0.0.1:3001/api/material-search/status', (res) => {
    res.resume();
    if (res.statusCode !== 200) return stop(1);
    const vite = spawn(
      process.execPath,
      [path.join(root, 'node_modules/vite/bin/vite.js'), '--strictPort', ...process.argv.slice(2)],
      { cwd: root, stdio: 'inherit' }
    );
    children.push(vite);
    vite.on('exit', (code) => {
      if (!stopping) stop(code || 0);
    });
  });
  req.on('error', () => {
    if (attempt >= 30) {
      console.error('素材服务启动超时。');
      stop(1);
    } else setTimeout(() => wait(attempt + 1), 200);
  });
}
wait();
