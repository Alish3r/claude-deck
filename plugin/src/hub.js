// The plugin's hub — an HTTP server the VS Code windows (host-inject) connect to, plus
// the state brain (arbiter + store). Same wire protocol as tools/mock-hub.mjs, but this
// one ingests events into focus arbitration + the session cache and routes dial commands
// to the current target window.
//
//   POST /events              host -> hub : focus / chat_closed / alive / relayed state+result
//   GET  /commands?window=&wait=  hub -> host : long-poll the next command for a window
//
// Discovery: writes hub.json {port, token} to tmpdir so the host-inject finds the port.
// In-process API for the plugin: sendToTarget(cmd), targetState(), onResult(cb).

import http from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArbiter } from './arbiter.js';
import { createStore } from './store.js';

const HUB_JSON = 'claude-deck-hub.json';

function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => resolve(d)); });
}

export function createHub({
  port = 0, token, maxWaitMs = 25_000,
  now = () => Date.now(),
  hubJsonPath = join(tmpdir(), HUB_JSON),
  writeHubJson = true,
} = {}) {
  const arbiter = createArbiter();
  const store = createStore();
  const queues = new Map();       // windowId -> [command]
  const waiters = new Map();      // windowId -> { res, timer }
  const events = [];              // audit trail
  const resultListeners = new Set();

  function ingest(evt) {
    events.push(evt);
    const wid = evt.windowId;
    if (evt.type === 'focus') { arbiter.ingestFocus(evt); store.markWindowSeen(); }
    else if (evt.type === 'chat_closed') { if (wid && evt.sessionId) store.tombstone(wid, evt.sessionId); }
    else if (evt.type === 'alive') { store.markWindowSeen(); }
    else if (evt.kind === 'state') { store.ingestState(evt); }
    if (evt.kind === 'result') for (const cb of resultListeners) cb(evt);
  }

  function enqueueTo(windowId, command) {
    const w = waiters.get(windowId);
    if (w) {
      clearTimeout(w.timer); waiters.delete(windowId);
      w.res.writeHead(200, { 'content-type': 'application/json' }); w.res.end(JSON.stringify(command));
      return;
    }
    if (!queues.has(windowId)) queues.set(windowId, []);
    queues.get(windowId).push(command);
  }

  // Route a dial command to whichever window/chat the dials currently control.
  function sendToTarget(command) {
    const t = arbiter.target(now());
    if (!t) return null;
    enqueueTo(t.windowId, { ...command, sessionId: command.sessionId ?? t.sessionId });
    return t;
  }

  function targetState() { return store.targetState(arbiter.target(now())); }
  function onResult(cb) { resultListeners.add(cb); return () => resultListeners.delete(cb); }

  const server = http.createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url, 'http://x');

    if (req.method === 'POST' && url.pathname === '/events') {
      ingest(JSON.parse((await readBody(req)) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return;
    }
    if (req.method === 'GET' && url.pathname === '/commands') {
      const w = url.searchParams.get('window');
      const wait = Math.min(Number(url.searchParams.get('wait') || 0), maxWaitMs);
      const q = queues.get(w);
      if (q && q.length) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(q.shift())); return; }
      const timer = setTimeout(() => { waiters.delete(w); res.writeHead(204); res.end(); }, wait);
      waiters.set(w, { res, timer }); return;
    }
    res.writeHead(404); res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      const info = { port: p, token: token ?? null };
      if (writeHubJson) { try { writeFileSync(hubJsonPath, JSON.stringify(info)); } catch { /* ignore */ } }
      resolve({
        server, port: p, url: `http://127.0.0.1:${p}`, token: token ?? null,
        arbiter, store, events,
        ingest, sendToTarget, targetState, onResult, enqueueTo,
        close: () => new Promise((r) => {
          for (const { timer, res } of waiters.values()) { clearTimeout(timer); try { res.writeHead(204); res.end(); } catch { /* gone */ } }
          waiters.clear();
          if (writeHubJson) { try { rmSync(hubJsonPath, { force: true }); } catch { /* ignore */ } }
          server.close(() => r());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
