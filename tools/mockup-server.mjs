// Static file server for the device-preview mockup. Rooted at the repo so the mockup can
// import the real plugin/src/lcd.js + patch/effort-ladder.js as ES modules.
//   node tools/mockup-server.mjs   →  http://127.0.0.1:7777/tools/mockup/
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // repo root
const PORT = Number(process.env.PORT || 7777);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p === '') p = '/tools/mockup/index.html';
    if (p.endsWith('/')) p += 'index.html';
    const abs = normalize(join(ROOT, p));
    if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const body = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`mockup: http://127.0.0.1:${PORT}/tools/mockup/`));
