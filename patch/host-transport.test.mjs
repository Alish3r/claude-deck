// Host transport integration tests — real node:http round-trip against the in-process
// mock hub. Proves the Node-built-in transport works end-to-end (the V2-audit HIGH
// regression: no external `ws`). Also drives the bridge through the real transport.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from '../tools/mock-hub.mjs';
import { HttpTransport } from './host/transport.js';
import { createHostBridge } from './host/bridge.js';

test('send() delivers an event to the hub over http', async () => {
  const hub = await startHub({ port: 0 });
  try {
    const t = new HttpTransport({ port: hub.port, windowId: 'wT' });
    await t.send({ type: 'focus', focused: true, activeSessionId: 'A' });
    assert.equal(hub.events.length, 1);
    assert.equal(hub.events[0].type, 'focus');
    assert.equal(hub.events[0].windowId, 'wT', 'transport stamps windowId');
  } finally { await hub.close(); }
});

test('long-poll delivers a queued command to the poller', async () => {
  const hub = await startHub({ port: 0 });
  try {
    const t = new HttpTransport({ port: hub.port, windowId: 'wP', waitMs: 1000 });
    hub.enqueue('wP', { op: 'set_effort', value: 'low', id: 42 });
    const cmd = await t.pollOnce();
    assert.deepEqual(cmd, { op: 'set_effort', value: 'low', id: 42 });
  } finally { await hub.close(); }
});

test('long-poll returns null (204) on timeout when no command is queued', async () => {
  const hub = await startHub({ port: 0 });
  try {
    const t = new HttpTransport({ port: hub.port, windowId: 'wIdle', waitMs: 120 });
    const cmd = await t.pollOnce();
    assert.equal(cmd, null);
  } finally { await hub.close(); }
});

test('token-guarded hub rejects an unauthenticated send', async () => {
  const hub = await startHub({ port: 0, token: 'secret' });
  try {
    const bad = new HttpTransport({ port: hub.port, windowId: 'w', token: 'wrong' });
    await assert.rejects(() => bad.send({ type: 'alive' }), /events 401/);
    const ok = new HttpTransport({ port: hub.port, windowId: 'w', token: 'secret' });
    await ok.send({ type: 'alive' });
    assert.equal(hub.events.length, 1);
  } finally { await hub.close(); }
});

test('end-to-end: hub command -> transport poll -> bridge routes to the panel', async () => {
  const hub = await startHub({ port: 0 });
  try {
    // fake manager with one panel that records posts
    const posted = [];
    const manager = {
      activeSessionId: 'S1',
      sessionPanels: new Map([['S1', { webview: { postMessage: (m) => posted.push(m) } }]]),
    };
    const transport = new HttpTransport({ port: hub.port, windowId: 'wE2E', waitMs: 1000 });
    const bridge = createHostBridge({ manager, transport, windowId: 'wE2E' });

    // hub pushes a command; the bridge (driven by the poll loop) routes it
    const got = new Promise((resolve) => {
      transport.startPolling(async (cmd) => { await bridge.handleCommand(cmd); resolve(cmd); });
    });
    hub.enqueue('wE2E', { op: 'set_model', value: 'claude-fable-5', sessionId: 'S1', id: 5 });

    const cmd = await got;
    transport.stop();
    assert.equal(cmd.op, 'set_model');
    assert.deepEqual(posted, [{ type: 'claudedeck_cmd', op: 'set_model', value: 'claude-fable-5', id: 5 }]);
  } finally { await hub.close(); }
});
