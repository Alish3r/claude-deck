// End-to-end integration — the REAL host bridge (#4) + two REAL webview bridges (#5) +
// http transport (#4) + mock-hub, wired into the full command→route→drive→ack→relay loop.
// Closes the M1 #2 cross-chat isolation leftover (M1 had only one open panel).
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHub } from '../tools/mock-hub.mjs';
import { wireTwoChats, waitFor } from '../tools/matrix.mjs';
import { setEffort, readEffort } from './effort.js';

async function withRig(fn) {
  const hub = await startHub({ port: 0 });
  const w = wireTwoChats(hub);
  try { await fn(hub, w); } finally { await w.close(); await hub.close(); }
}

test('cross-chat isolation: set_model on A changes A only, never B', async () => {
  await withRig(async (hub, w) => {
    hub.enqueue('win1', { op: 'set_model', value: 'claude-haiku-4-5', sessionId: 'A', id: 1 });
    await waitFor(() => w.cfA.modelSelection.value === 'claude-haiku-4-5');
    assert.equal(w.cfA.modelSelection.value, 'claude-haiku-4-5', 'A changed');
    assert.equal(w.cfB.modelSelection.value, 'claude-fable-5', 'B untouched');
  });
});

test('two-phase ack: a confirmed set_model result is relayed to the hub', async () => {
  await withRig(async (hub, w) => {
    hub.enqueue('win1', { op: 'set_model', value: 'claude-haiku-4-5', sessionId: 'A', id: 2 });
    const confirmed = await waitFor(() => hub.events.find((e) => e.kind === 'result' && e.phase === 'confirmed' && e.id === 2));
    assert.ok(confirmed, 'confirmed ack reached the hub');
    assert.equal(confirmed.op, 'set_model');
    assert.equal(confirmed.ok, true);
  });
});

test('focus report reaches the hub with the active session', async () => {
  await withRig(async (hub, w) => {
    await w.hostBridge.reportFocus();
    const focus = await waitFor(() => hub.events.find((e) => e.type === 'focus'));
    assert.ok(focus);
    assert.equal(focus.activeSessionId, 'A');
    assert.equal(focus.focused, true);
  });
});

test('enable_ultracode (dial "ultracode" top) drives the addressed chat', async () => {
  await withRig(async (hub, w) => {
    hub.enqueue('win1', { op: 'enable_ultracode', sessionId: 'B', id: 3 });
    await waitFor(() => w.cfB.ultracodeEnabled.value === true);
    assert.equal(w.cfB.ultracodeEnabled.value, true);
    assert.equal(w.cfA.ultracodeEnabled.value, false, 'A not affected');
  });
});

test('a command to a disposed chat yields an error result, not a throw', async () => {
  await withRig(async (hub, w) => {
    await w.hostBridge.disposePanel('B');
    hub.enqueue('win1', { op: 'set_model', value: 'claude-fable-5', sessionId: 'B', id: 4 });
    const err = await waitFor(() => hub.events.find((e) => e.type === 'result' && e.ok === false && e.sessionId === 'B'));
    assert.ok(err, 'error result relayed');
    assert.equal(err.error, 'tombstoned');
  });
});

test('effort ⊙GLOBAL round-trip: level set then Auto (unset) via settings.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-int-eff-'));
  const p = join(dir, 'settings.json');
  try {
    writeFileSync(p, '{\n  "effortLevel": "high"\n}\n');
    setEffort(p, 'xhigh');
    assert.equal(readEffort(p), 'xhigh');
    setEffort(p, 'auto'); // the setEffortLevel(undefined) -> Auto equivalent
    assert.equal(readEffort(p), 'auto');
    assert.equal('effortLevel' in JSON.parse(readFileSync(p, 'utf8')), false, 'key removed for Auto');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
