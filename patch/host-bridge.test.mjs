// Host bridge logic tests — mock manager + fake transport, no VS Code, no network.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostBridge } from './host/bridge.js';

// A fake panel records what the host posts into its webview.
function fakePanel() {
  const posted = [];
  return { webview: { postMessage: (m) => posted.push(m) }, posted };
}

// A fake manager with a couple of panels + an active session.
function fakeManager(active = 'A') {
  const sessionPanels = new Map();
  const pA = fakePanel(), pB = fakePanel();
  sessionPanels.set('A', pA);
  sessionPanels.set('B', pB);
  return { sessionPanels, activeSessionId: active, _pA: pA, _pB: pB };
}

// A fake transport that records every sent event.
function fakeTransport() {
  const sent = [];
  return { sent, send: (e) => { sent.push(e); return Promise.resolve(true); } };
}

test('routes a command to the addressed session (not the active one)', async () => {
  const manager = fakeManager('A');
  const transport = fakeTransport();
  const b = createHostBridge({ manager, transport, windowId: 'w1' });

  const r = await b.handleCommand({ op: 'set_model', value: 'claude-haiku-4-5', sessionId: 'B', id: 7 });
  assert.equal(r.routed, true);
  assert.equal(r.sid, 'B');
  assert.deepEqual(manager._pB.posted, [{ type: 'claudedeck_cmd', op: 'set_model', value: 'claude-haiku-4-5', id: 7 }]);
  assert.equal(manager._pA.posted.length, 0, 'active session A must not receive B\'s command');
});

test('falls back to activeSessionId when the command omits sessionId', async () => {
  const manager = fakeManager('A');
  const b = createHostBridge({ manager, transport: fakeTransport(), windowId: 'w1' });
  await b.handleCommand({ op: 'resync' });
  assert.equal(manager._pA.posted.length, 1);
  assert.equal(manager._pB.posted.length, 0);
});

test('missing panel => error event to hub, no postMessage', async () => {
  const manager = fakeManager('A');
  const transport = fakeTransport();
  const b = createHostBridge({ manager, transport, windowId: 'w1' });
  const r = await b.handleCommand({ op: 'set_model', value: 'x', sessionId: 'ZZZ', id: 3 });
  assert.equal(r.routed, false);
  assert.equal(r.reason, 'no panel');
  const err = transport.sent.find((e) => e.type === 'result' && e.ok === false);
  assert.ok(err, 'an error result should be sent');
  assert.equal(err.sessionId, 'ZZZ');
});

test('dispose tombstones the session, emits chat_closed, and refuses later routing', async () => {
  const manager = fakeManager('A');
  const transport = fakeTransport();
  const b = createHostBridge({ manager, transport, windowId: 'w1' });

  await b.disposePanel('B');
  assert.ok(b.tombstones.has('B'));
  assert.ok(transport.sent.some((e) => e.type === 'chat_closed' && e.sessionId === 'B'));
  assert.equal(manager.sessionPanels.has('B'), false, 'panel removed from manager');

  const r = await b.handleCommand({ op: 'set_model', value: 'x', sessionId: 'B', id: 1 });
  assert.equal(r.routed, false);
  assert.equal(r.reason, 'tombstoned');
});

test('reportFocus emits focus + active session', async () => {
  const manager = fakeManager('A');
  const transport = fakeTransport();
  const b = createHostBridge({ manager, transport, windowId: 'w1', focus: () => ({ focused: true }) });
  await b.reportFocus();
  const f = transport.sent.find((e) => e.type === 'focus');
  assert.equal(f.focused, true);
  assert.equal(f.activeSessionId, 'A');
  assert.equal(f.windowId, 'w1');
});

test('alive writes the heartbeat file and notifies the hub', async () => {
  let wrote = 0;
  const transport = fakeTransport();
  const b = createHostBridge({ manager: fakeManager(), transport, windowId: 'w1', writeAlive: () => { wrote++; } });
  await b.alive();
  assert.equal(wrote, 1);
  assert.ok(transport.sent.some((e) => e.type === 'alive'));
});

test('relay forwards a webview snapshot to the hub with windowId', async () => {
  const transport = fakeTransport();
  const b = createHostBridge({ manager: fakeManager(), transport, windowId: 'w9' });
  await b.relay({ type: 'claudedeck_evt', kind: 'state', sessionId: 'A', effort: 'xhigh' });
  const s = transport.sent.find((e) => e.kind === 'state');
  assert.equal(s.windowId, 'w9');
  assert.equal(s.relayed, true);
  assert.equal(s.effort, 'xhigh');
});
