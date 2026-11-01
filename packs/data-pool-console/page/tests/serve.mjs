// Local harness: serves the bundle with the soot-pages bundle headers and a fake
// Nest host page. Usage: node serve.mjs [port]. Not shipped (release archives leave out tests/).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const port = Number(process.argv[2] || 8765);
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const bundle = url.pathname.startsWith('/page/');
  const rel = normalize(bundle ? url.pathname.slice(6) || 'index.html' : url.pathname.replace(/^\/host\//, 'tests/')).replace(/^\/+/, '');
  if (rel.includes('..') || (!bundle && !rel.startsWith('tests/'))) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(join(root, rel.endsWith('/') ? rel + 'index.html' : rel));
    const headers = { 'Content-Type': types[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (bundle) headers['Content-Security-Policy'] = "default-src 'self'; connect-src 'none'; frame-ancestors 'self' tauri: http://tauri.localhost";
    res.writeHead(200, headers).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/host/host.html`));
