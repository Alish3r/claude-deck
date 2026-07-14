// Plugin brain tests — arbiter, store, dial-control (pure, injected clock/timers) + the
// hub over real node:http. Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArbiter } from './src/arbiter.js';
import { createStore } from './src/store.js';
import { createDialControl } from './src/dial-control.js';
import { createHub } from './src/hub.js';
import { HttpTransport } from '../patch/host/transport.js';

// --- arbiter ---------------------------------------------------------------

test('arbiter: the focused window (latest ts) wins', () => {
  const a = createArbiter();
  a.ingestFocus({ windowId: 'A', focused: true, activeSessionId: 's1', ts: 1 });
  a.ingestFocus({ windowId: 'B', focused: true, activeSessionId: 's2', ts: 5 });
  assert.deepEqual(a.rawTarget(), { windowId: 'B', sessionId: 's2' });
});

test('arbiter: sticky last-focused when nothing is focused now', () => {
  const a = createArbiter();
  a.ingestFocus({ windowId: 'A', focused: true, activeSessionId: 's1', ts: 1 });
  a.ingestFocus({ windowId: 'A', focused: false, activeSessionId: 's1', ts: 2 }); // blurred
  assert.deepEqual(a.rawTarget(), { windowId: 'A', sessionId: 's1' });
});

test('arbiter: removeWindow clears sticky', () => {
  const a = createArbiter();
  a.ingestFocus({ windowId: 'A', focused: true, activeSessionId: 's1', ts: 1 });
  a.removeWindow('A');
  assert.equal(a.rawTarget(), null);
});

test('arbiter: debounce holds a retarget until it is stable', () => {
  const a = createArbiter({ debounceMs: 150 });
  a.ingestFocus({ windowId: 'A', focused: true, activeSessionId: 's1', ts: 1 });
  assert.deepEqual(a.target(0), { windowId: 'A', sessionId: 's1' }); // first commits immediately
  a.ingestFocus({ windowId: 'B', focused: true, activeSessionId: 's2', ts: 2 });
  assert.deepEqual(a.target(50), { windowId: 'A', sessionId: 's1' }, 'B not committed yet (debounced)');
  assert.deepEqual(a.target(250), { windowId: 'B', sessionId: 's2' }, 'B committed after it stayed stable');
});

// --- store -----------------------------------------------------------------

test('store: targetState sentinels — no-vscode / no-chat / not-started / ok', () => {
  const s = createStore();
  assert.equal(s.targetState(null).kind, 'no-vscode');
  s.markWindowSeen();
  assert.equal(s.targetState(null).kind, 'no-chat');
  assert.equal(s.targetState({ windowId: 'A', sessionId: 's1' }).kind, 'not-started');
  s.ingestState({ windowId: 'A', sessionId: 's1', modelOverride: 'claude-fable-5', effort: 'xhigh', catalog: [] });
  const t = s.targetState({ windowId: 'A', sessionId: 's1' });
  assert.equal(t.kind, 'ok');
  assert.equal(t.model, 'claude-fable-5');
  assert.equal(t.effort, 'xhigh');
});

test('store: tombstone removes a chat and ignores late snapshots', () => {
  const s = createStore();
  s.ingestState({ windowId: 'A', sessionId: 's1', modelOverride: 'm', effort: 'high' });
  s.tombstone('A', 's1');
  assert.equal(s.targetState({ windowId: 'A', sessionId: 's1' }).kind, 'not-started');
  s.ingestState({ windowId: 'A', sessionId: 's1', modelOverride: 'm2' }); // late — ignored
  assert.equal(s.targetState({ windowId: 'A', sessionId: 's1' }).kind, 'not-started');
});

// --- dial control ----------------------------------------------------------

function fakeTimers() {
  const q = new Map(); let id = 0;
  return {
    setTimer: (fn) => { const i = ++id; q.set(i, fn); return i; },
    clearTimer: (i) => q.delete(i),
    run: () => { const fns = [...q.values()]; q.clear(); fns.forEach((f) => f()); },
  };
}

test('dial: rotation coalesces to one apply after the debounce, monotonic seq', () => {
  const t = fakeTimers();
  const applied = [];
  const d = createDialControl({ onApply: (a) => applied.push(a), setTimer: t.setTimer, clearTimer: t.clearTimer });
  d.rotate('low'); d.rotate('medium'); d.rotate('high'); // browse
  assert.equal(applied.length, 0, 'nothing applied mid-browse');
  t.run();
  assert.deepEqual(applied, [{ seq: 1, value: 'high' }], 'one apply with the final value');
  d.rotate('xhigh'); t.run();
  assert.equal(applied[1].seq, 2, 'seq is monotonic');
});

test('dial: flushNow applies immediately; ack classifies confirmed/stale/unknown', () => {
  const t = fakeTimers();
  const applied = [];
  const d = createDialControl({ onApply: (a) => applied.push(a), setTimer: t.setTimer, clearTimer: t.clearTimer });
  d.rotate('high'); d.flushNow();  // seq 1 (in flight, never acked)
  assert.equal(applied[0].seq, 1);
  d.rotate('xhigh'); d.flushNow(); // seq 2 now latest; in flight {1, 2}
  assert.equal(d.ack(2), 'confirmed', 'latest seq confirms');
  assert.equal(d.ack(1), 'stale', 'seq 1 was in flight but is superseded by 2');
  assert.equal(d.ack(1), 'unknown', 'seq 1 already removed');
  assert.equal(d.ack(99), 'unknown', 'never in flight');
});

// --- hub (real http) -------------------------------------------------------

test('hub: focus + state ingested; sendToTarget routes to the focused window', async () => {
  const hub = await createHub({ port: 0, writeHubJson: false });
  try {
    const t = new HttpTransport({ port: hub.port, windowId: 'A', waitMs: 800 });
    await t.send({ type: 'focus', focused: true, activeSessionId: 's1', ts: 1 });
    await t.send({ type: 'claudedeck_evt', kind: 'state', windowId: 'A', sessionId: 's1', modelOverride: 'claude-fable-5', effort: 'xhigh', catalog: [] });

    const ts = hub.targetState();
    assert.equal(ts.kind, 'ok');
    assert.equal(ts.model, 'claude-fable-5');

    const routed = hub.sendToTarget({ op: 'set_model', value: 'claude-haiku-4-5', id: 1 });
    assert.equal(routed.windowId, 'A');
    const cmd = await t.pollOnce();
    assert.equal(cmd.op, 'set_model');
    assert.equal(cmd.sessionId, 's1', 'command carries the target session');
  } finally { await hub.close(); }
});

test('hub: chat_closed tombstones; onResult fires on result events', async () => {
  const hub = await createHub({ port: 0, writeHubJson: false });
  try {
    const t = new HttpTransport({ port: hub.port, windowId: 'A' });
    const results = [];
    hub.onResult((r) => results.push(r));
    await t.send({ type: 'focus', focused: true, activeSessionId: 's1', ts: 1 });
    await t.send({ type: 'claudedeck_evt', kind: 'state', windowId: 'A', sessionId: 's1', modelOverride: 'm' });
    await t.send({ type: 'claudedeck_evt', kind: 'result', windowId: 'A', op: 'set_model', id: 1, ok: true });
    await t.send({ type: 'chat_closed', windowId: 'A', sessionId: 's1' });

    assert.ok(results.some((r) => r.op === 'set_model'), 'result relayed to listener');
    assert.equal(hub.targetState().kind, 'not-started', 'closed chat tombstoned');
  } finally { await hub.close(); }
});

test('hub: writes hub.json {port,token} for discovery', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'cd-hubjson-'));
  const hubJsonPath = join(dir, 'hub.json');
  const hub = await createHub({ port: 0, token: 'secret', hubJsonPath });
  try {
    const info = JSON.parse(readFileSync(hubJsonPath, 'utf8'));
    assert.equal(info.port, hub.port);
    assert.equal(info.token, 'secret');
  } finally { await hub.close(); rmSync(dir, { recursive: true, force: true }); }
});
