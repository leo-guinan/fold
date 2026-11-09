#!/usr/bin/env node
// Static file server for previews and exports. Serves the repo root, so pages can load ../../dist/.
//   node tools/serve.mjs [path-to-open] [--port 8780]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.map': 'application/json', '.woff2': 'font/woff2' };
/** Answer a request with a file under root (or a 404). */
export function sendFile(root, req, res) {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname); const f = path.join(root, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
}
export function serve(root, port = 0) {
  const server = http.createServer((req, res) => sendFile(root, req, res));
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const pi = args.indexOf('--port'); const port = pi >= 0 ? +args[pi + 1] : 8780;
  const open = args.find(a => !a.startsWith('--') && a !== String(port)) || '';
  const { url } = await serve(repoRoot, port); console.log(`serving ${repoRoot}\n${url}/${open}`);
}
