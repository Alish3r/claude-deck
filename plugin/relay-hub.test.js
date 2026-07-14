// Relay-hub tests — in-memory io, controllable clock. Covers the v4 relay semantics:
// active-tab preference, dead-window filtering, per-command files, per-result consumption,
// startup purge, ultracode rung synthesis, live-catalog preference. Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRelayHub } from './src/relay-hub.js';

const DIR = 'X:/tmp';

function memIo(clock) {
  const files = new Map(); // full path -> { data, mtime }
  return {
    files,
    put(name, obj, mtime = clock.t) { files.set(join(DIR, name), { data: JSON.stringify(obj), mtime }); },
    names() { return [...files.keys()].map((p) => p.split(/[\\/]/).pop()); },
    io: {
      readdir: () => [...files.keys()].map((p) => p.split(/[\\/]/).pop()),
      read: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p).data; },
      write: (p, d) => files.set(p, { data: d, mtime: clock.t }),
      rename: (a, b) => { if (!files.has(a)) throw new Error('ENOENT'); files.set(b, files.get(a)); files.delete(a); },
      unlink: (p) => { if (!files.has(p)) throw new Error('ENOENT'); files.delete(p); },
      exists: (p) => files.has(p),
      mtime: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p).mtime; },
    },
  };
}

function rig({ effort = 'high', catalog } = {}) {
  const clock = { t: 1_000_000 };
  const m = memIo(clock);
  const make = () => createRelayHub({
    catalog: catalog ?? [{ value: 'default', label: 'Default' }],
    now: () => clock.t, io: m.io, dir: DIR,
    readEffortFn: () => effort,
  });
  return { clock, m, make };
}

const state = (over = {}) => ({
  type: 'claudedeck_evt', kind: 'state', sessionId: 's1', windowId: 'W1',
  modelOverride: 'claude-fable-5[1m]', modelEffective: 'claude-fable-5[1m]',
  focused: true, active: true, summary: 'chat', busy: false, ultracode: false, ...over,
});

test('active tab beats a busier background chat in the same focused window', () => {
  const { clock, m, make } = rig();
  m.put('claude-deck-alive-W1.json', { t: clock.t }, clock.t);
  m.put('claude-deck-state-sA.json', state({ sessionId: 'sA', active: true }), clock.t - 5000);
  m.put('claude-deck-state-sB.json', state({ sessionId: 'sB', active: false, busy: true }), clock.t - 100); // fresher!
  const hub = make();
  assert.equal(hub.targetState().sessionId, 'sA', 'the ACTIVE tab wins despite older mtime');
  hub._stop();
});

test('active tab wins even when ITS snapshot has focused:false (stale window focus)', () => {
  // the exact live bug: the active Opus tab was snapped while the window was unfocused
  // (focused:false), a background Sonnet tab had focused:true — the dial showed Sonnet
  const { clock, m, make } = rig();
  m.put('claude-deck-alive-W1.json', { t: clock.t }, clock.t);
  m.put('claude-deck-state-sA.json', state({ sessionId: 'sA', active: true, focused: false, modelEffective: 'claude-opus-4-8' }), clock.t);
  m.put('claude-deck-state-sB.json', state({ sessionId: 'sB', active: false, focused: true, modelEffective: 'claude-sonnet-5' }), clock.t - 3000);
  const hub = make();
  assert.equal(hub.targetState().sessionId, 'sA', 'the active tab wins despite focused:false');
  assert.equal(hub.targetState().model, 'claude-opus-4-8');
  hub._stop();
});

test('pre-v4 states (no active stamp) fall back to newest-focused', () => {
  const { clock, m, make } = rig();
  m.put('claude-deck-alive-W1.json', { t: clock.t }, clock.t);
  const s = state({ sessionId: 'sA' }); delete s.active;
  const s2 = state({ sessionId: 'sB' }); delete s2.active;
  m.put('claude-deck-state-sA.json', s, clock.t - 5000);
  m.put('claude-deck-state-sB.json', s2, clock.t - 100);
  const hub = make();
  assert.equal(hub.targetState().sessionId, 'sB');
  hub._stop();
});

test('a dead window (stale alive stamp) cannot steer the dials', () => {
  const { clock, m, make } = rig();
  m.put('claude-deck-alive-W1.json', { t: 0 }, clock.t - 60_000); // stale stamp = dead
  m.put('claude-deck-state-sA.json', state(), clock.t - 50_000);
  const hub = make();
  assert.equal(hub.targetState().kind, 'no-vscode');
  hub._stop();
});

test('no alive stamp at all: only FRESH state files count (immortal pre-v3 junk excluded)', () => {
  const { clock, m, make } = rig();
  m.put('claude-deck-state-old.json', state({ sessionId: 'old' }), clock.t - 120_000);
  m.put('claude-deck-state-new.json', state({ sessionId: 'new' }), clock.t - 10_000);
  const hub = make();
  assert.equal(hub.targetState().sessionId, 'new');
  hub._stop();
});

test('sendToTarget writes one unique file per command; nothing is overwritten', () => {
  const { clock, m, make } = rig();
  m.put('claude-deck-alive-W1.json', { t: clock.t }, clock.t);
  m.put('claude-deck-state-s1.json', state(), clock.t);
  const hub = make();
  hub.sendToTarget({ op: 'compact', id: 'model:1' });
  hub.sendToTarget({ op: 'set_model', value: 'sonnet', id: 'model:2' });
  const cmds = m.names().filter((n) => n.startsWith('claude-deck-cmd-W1-'));
  assert.equal(cmds.length, 2, 'two commands, two files');
  assert.ok(!m.names().some((n) => n.endsWith('.tmp')), 'atomic rename left no tmp files');
  hub._stop();
});

test('explicit windowId/sessionId (browse-time pinning) beats current focus', () => {
  const { clock, m, make } = rig();
  m.put('claude-deck-alive-W2.json', { t: clock.t }, clock.t);
  m.put('claude-deck-state-s2.json', state({ sessionId: 's2', windowId: 'W2' }), clock.t);
  const hub = make();
  const r = hub.sendToTarget({ op: 'set_model', value: 'sonnet', id: 'model:3', windowId: 'W9', sessionId: 's9' });
  assert.equal(r.windowId, 'W9');
  assert.ok(m.names().some((n) => n.startsWith('claude-deck-cmd-W9-')), 'routed to the pinned window');
  hub._stop();
});

test('per-result files are consumed in order and unlinked; startup purges stale ones', () => {
  const { clock, m, make } = rig();
  m.put('claude-deck-res-W1-1.json', { kind: 'result', op: 'set_model', ok: false, id: 'model:9' }); // pre-existing = stale
  const hub = make();
  assert.equal(m.names().filter((n) => n.startsWith('claude-deck-res-')).length, 0, 'stale results purged at startup');
  const got = [];
  hub.onResult((r) => got.push(r));
  m.put('claude-deck-res-W1-2.json', { kind: 'result', op: 'set_model', ok: true, id: 'model:1' });
  m.put('claude-deck-res-W1-3.json', { kind: 'result', op: 'compact', ok: true, id: 'model:2' });
  hub._pollResults();
  assert.deepEqual(got.map((r) => r.id), ['model:1', 'model:2']);
  assert.equal(m.names().filter((n) => n.startsWith('claude-deck-res-')).length, 0, 'consumed results unlinked');
  hub._stop();
});

test('effort DISPLAY is per-chat but the browse/write ANCHOR is the authoritative global', () => {
  const { clock, m, make } = rig({ effort: 'low' }); // settings.json (global) says low
  m.put('claude-deck-alive-W1.json', { t: clock.t }, clock.t);
  m.put('claude-deck-state-s1.json', state({ effort: 'max' }), clock.t); // this chat's signal says max
  const hub = make();
  const ts = hub.targetState();
  assert.equal(ts.effort, 'max', 'LCD shows the chat’s own (per-chat) effort signal');
  assert.equal(ts.effortGlobal, 'low', 'the dial steps/writes from the real global effort — never the stale per-chat value');
  hub._stop();
});

test('two chats in one window show their own different effort levels', () => {
  const { clock, m, make } = rig({ effort: 'low' });
  m.put('claude-deck-alive-W1.json', { t: clock.t }, clock.t);
  m.put('claude-deck-state-sA.json', state({ sessionId: 'sA', active: true, effort: 'max' }), clock.t);
  m.put('claude-deck-state-sB.json', state({ sessionId: 'sB', active: false, effort: 'high' }), clock.t - 50);
  const hub = make();
  assert.equal(hub.targetState().effort, 'max', 'active chat A -> max');
  hub._stop();
});

test('effort falls back to global settings when the snapshot carries none (pre-v5)', () => {
  const { clock, m, make } = rig({ effort: 'high' });
  m.put('claude-deck-alive-W1.json', { t: clock.t }, clock.t);
  const noEffort = state(); delete noEffort.effort;
  m.put('claude-deck-state-s1.json', noEffort, clock.t);
  const hub = make();
  assert.equal(hub.targetState().effort, 'high', 'global settings read is the fallback');
  hub._stop();
});

test('ultracode rung synthesized from settings xhigh + focused chat flag; junk effort -> auto', () => {
  const { clock, m, make } = rig({ effort: 'xhigh' });
  m.put('claude-deck-alive-W1.json', { t: clock.t }, clock.t);
  m.put('claude-deck-state-s1.json', state({ ultracode: true }), clock.t);
  const hub = make();
  assert.equal(hub.targetState().effort, 'ultracode');
  hub._stop();

  const junk = rig({ effort: 'banana' });
  junk.m.put('claude-deck-alive-W1.json', { t: junk.clock.t }, junk.clock.t);
  junk.m.put('claude-deck-state-s1.json', state(), junk.clock.t);
  const hub2 = junk.make();
  assert.equal(hub2.targetState().effort, 'auto');
  hub2._stop();
});

test('live snapshot catalog beats the static fallback', () => {
  const { clock, m, make } = rig({ catalog: [{ value: 'stale', label: 'Stale' }] });
  m.put('claude-deck-alive-W1.json', { t: clock.t }, clock.t);
  m.put('claude-deck-state-s1.json', state({ catalog: [{ value: 'claude-fable-5[1m]', label: 'Fable' }] }), clock.t);
  const hub = make();
  assert.deepEqual(hub.targetState().catalog.map((c) => c.value), ['claude-fable-5[1m]']);
  hub._stop();
});
