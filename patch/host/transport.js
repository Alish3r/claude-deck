// Host <-> hub transport over a Node built-in (`node:http`) — NOT external `ws`.
//
// The injected host code runs inside the extension host, which cannot `require('ws')`
// and (Node 20) has no stable global WebSocket. So the transport is plain HTTP:
//   POST /events            — fire an event at the hub
//   GET  /commands?window=  — long-poll for the next command addressed to this window
// This is the V2-audit HIGH-regression fix; it round-trips against a real http server.

import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpTransport {
  constructor({ host = '127.0.0.1', port, token, windowId, waitMs = 25_000 } = {}) {
    if (!port) throw new Error('HttpTransport requires a port');
    if (!windowId) throw new Error('HttpTransport requires a windowId');
    this.host = host; this.port = port; this.token = token;
    this.windowId = windowId; this.waitMs = waitMs; this._run = false;
    this._activeReq = null; this._loop = null;
  }

  // Track the in-flight request so stop() can abort a blocked long-poll immediately.
  _request({ path, method, headers = {} }, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: this.host, port: this.port, path, method, headers }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      this._activeReq = req;
      req.on('error', reject);
      req.on('close', () => { if (this._activeReq === req) this._activeReq = null; });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  _auth() { return this.token ? { authorization: `Bearer ${this.token}` } : {}; }

  async send(event) {
    const body = JSON.stringify({ ...event, windowId: event.windowId ?? this.windowId });
    const res = await this._request({
      path: '/events', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...this._auth() },
    }, body);
    if (res.status >= 300) throw new Error(`hub /events ${res.status}`);
    return true;
  }

  // One long-poll cycle. Returns a command object, or null on timeout (204).
  async pollOnce() {
    const path = `/commands?window=${encodeURIComponent(this.windowId)}&wait=${this.waitMs}`;
    const res = await this._request({ path, method: 'GET', headers: this._auth() });
    if (res.status === 204 || !res.body) return null;
    if (res.status >= 300) throw new Error(`hub /commands ${res.status}`);
    return JSON.parse(res.body);
  }

  // Long-poll loop; calls onCommand for each delivered command until stop().
  startPolling(onCommand) {
    this._run = true;
    this._loop = (async () => {
      while (this._run) {
        try {
          const cmd = await this.pollOnce();
          if (cmd && this._run) await onCommand(cmd);
        } catch {
          if (this._run) await sleep(500); // hub down / transient — back off, keep trying
        }
      }
    })();
    return this._loop;
  }

  // Stop polling and resolve once the loop has fully drained — aborting any in-flight
  // long-poll immediately so no request outlives the caller (prevents post-teardown
  // ECONNRESET). Awaitable.
  async stop() {
    this._run = false;
    if (this._activeReq) { try { this._activeReq.destroy(); } catch { /* already gone */ } }
    try { await this._loop; } catch { /* loop swallows its own errors */ }
    this._loop = null;
  }
}
