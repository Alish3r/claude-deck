// Minimal in-process hub for developing/testing the host transport (#4).
// #7 extends this into the full verification-matrix harness. Node built-ins only.
//
// Endpoints:
//   POST /events              — record an event (host -> hub)
//   GET  /commands?window=&wait=  — long-poll the next command for a window (hub -> host)
//   POST /enqueue {window,command} — queue a command for a window (dev/test seam)
//
// Programmatic: `const hub = await startHub({ port: 0 })` -> { url, port, events, enqueue, close }
// CLI:          `node tools/mock-hub.mjs [--port 28710] [--token secret]`

import http from 'node:http';

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
  });
}

export function startHub({ port = 0, token, maxWaitMs = 25_000, log = false } = {}) {
  const events = [];
  const queues = new Map();   // window -> [command]
  const waiters = new Map();  // window -> { res, timer }

  function enqueue(window, command) {
    const w = waiters.get(window);
    if (w) {
      clearTimeout(w.timer);
      waiters.delete(window);
      w.res.writeHead(200, { 'content-type': 'application/json' });
      w.res.end(JSON.stringify(command));
      return;
    }
    if (!queues.has(window)) queues.set(window, []);
    queues.get(window).push(command);
  }

  const server = http.createServer(async (req, res) => {
    if (token) {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    }
    const url = new URL(req.url, 'http://x');

    if (req.method === 'POST' && url.pathname === '/events') {
      const evt = JSON.parse((await readBody(req)) || '{}');
      events.push(evt);
      if (log) console.log('[hub] event', JSON.stringify(evt));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/enqueue') {
      const { window, command } = JSON.parse((await readBody(req)) || '{}');
      enqueue(window, command);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/commands') {
      const w = url.searchParams.get('window');
      const wait = Math.min(Number(url.searchParams.get('wait') || 0), maxWaitMs);
      const q = queues.get(w);
      if (q && q.length) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(q.shift()));
        return;
      }
      const timer = setTimeout(() => { waiters.delete(w); res.writeHead(204); res.end(); }, wait);
      waiters.set(w, { res, timer });
      return;
    }

    res.writeHead(404); res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        server, port: p, url: `http://127.0.0.1:${p}`, events, enqueue,
        close: () => new Promise((r) => {
          // end any in-flight long-polls so their sockets close, then force-drop the rest
          for (const { timer, res } of waiters.values()) {
            clearTimeout(timer);
            try { res.writeHead(204); res.end(); } catch { /* already gone */ }
          }
          waiters.clear();
          server.close(() => r());
          server.closeAllConnections?.(); // Node 18.2+: drop idle keep-alive sockets
        }),
      });
    });
  });
}

// CLI mode
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/mock-hub.mjs')) {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const port = Number(get('--port', '28710'));
  const token = get('--token', undefined);
  startHub({ port, token, log: true }).then((hub) => {
    console.log(`[hub] listening on ${hub.url}${token ? ' (token required)' : ''}`);
  });
}
