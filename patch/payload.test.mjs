// Injected-payload tests — run the REAL W_BRIDGE string (anchors.js) in a vm sandbox
// shaped like the live 2.1.209 webview: claudeConfig is a SIGNAL (.value.models),
// descriptors carry .displayName, and setModel(e) is async + optimistically sets
// modelSelection then ROLLS BACK when the backend rejects (the silent-no-op trap the
// spike bridge fell into: ok:true ack, no actual change). Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { STEPS } from './anchors.js';

const W_BRIDGE = STEPS.find((s) => s.id === 'W-bridge').payload;

function signal(v) {
  const subs = new Set();
  return {
    get value() { return v; },
    set(nv) { v = nv; for (const f of [...subs]) f(nv); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

// A live-shaped Cf: claudeConfig signal with {models:[{value,displayName}]}, async
// setModel that accepts only catalog values (full-descriptor or not, it validates by
// .value) and rolls back modelSelection on rejection — mirroring the bundle's behavior.
function makeCf({ models, accept } = {}) {
  const list = models ?? [
    { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-4-8[1m]' },
    { value: 'claude-fable-5[1m]', displayName: 'Fable 5 (1M context)', resolvedModel: 'claude-fable-5' },
    { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
  ];
  const backendAccepts = accept ?? ((d) => list.some((m) => m.value === d.value && !!d.displayName));
  const cf = {
    sessionId: signal('S1'),
    modelSelection: signal('claude-fable-5[1m]'),
    // currentMainLoopModel is the ACTUAL running model (backend truth); modelSelection is
    // the picker override, which lags when the model is changed via /model.
    currentMainLoopModel: signal('claude-fable-5'),
    // live descriptors carry displayName, not label
    currentModelInfo: signal({ value: 'claude-fable-5[1m]', displayName: 'Fable 5 (1M context)' }),
    effortLevel: signal('max'),
    ultracodeEnabled: signal(false),
    thinkingLevelOverride: signal('off'),
    summary: signal('chat'),
    busy: signal(false),
    claudeConfig: signal({ models: list }),
    calls: [],
    sent: [], // prompt submissions (the real /compact path)
    async setModel(e) {
      cf.calls.push(e);
      const prev = cf.modelSelection.value;
      cf.modelSelection.set(e.value); // optimistic, like the live bundle
      if (!backendAccepts(e)) { cf.modelSelection.set(prev); return false; } // rollback
      return true;
    },
    // the live Cf's prompt-submit method: send(text, attachments, includeSelection)
    async send(e, t, i) { cf.sent.push({ text: e, attachments: t, selection: i }); return true; },
  };
  return cf;
}

function harness(cf) {
  const posts = [];
  const listeners = [];
  const timers = [];
  const sandbox = {
    window: {
      acquireVsCodeApi: () => ({ postMessage: (m) => posts.push(m) }),
      addEventListener: (type, fn) => listeners.push(fn),
    },
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(W_BRIDGE, sandbox);
  sandbox.__cdAttach({ activeSession: signal(cf) });
  const dispatch = (d) => { for (const fn of listeners) fn({ data: d }); };
  const flushTimers = () => { const t = timers.splice(0); for (const fn of t) fn(); };
  const tick = () => new Promise((r) => setImmediate(r));
  const states = () => posts.filter((p) => p.kind === 'state');
  const results = () => posts.filter((p) => p.kind === 'result');
  return { posts, dispatch, flushTimers, tick, states, results };
}

test('payload snapshot includes the live catalog (claudeConfig.value.models, displayName as label)', () => {
  const cf = makeCf();
  const h = harness(cf);
  const s = h.states().at(-1);
  assert.ok(s, 'a snapshot was posted on attach');
  // JSON round-trip: vm-realm objects have a foreign Object prototype (strict deepEqual
  // rejects cross-realm), and the file-relay JSON-serializes anyway — this IS the wire shape.
  assert.deepEqual(JSON.parse(JSON.stringify(s.catalog)), [
    { value: 'default', label: 'Default (recommended)', resolved: 'claude-opus-4-8[1m]' },
    { value: 'claude-fable-5[1m]', label: 'Fable 5 (1M context)', resolved: 'claude-fable-5' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8', resolved: null },
  ]);
});

test('set_model passes the FULL descriptor from the catalog, not a bare {value}', async () => {
  const cf = makeCf();
  const h = harness(cf);
  h.dispatch({ type: 'claudedeck_cmd', op: 'set_model', value: 'claude-opus-4-8' });
  await h.tick();
  assert.equal(cf.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(cf.calls[0])), { value: 'claude-opus-4-8', displayName: 'Opus 4.8' });
  const r = h.results().at(-1);
  assert.equal(r.op, 'set_model');
  assert.equal(r.ok, true);
  assert.equal(cf.modelSelection.value, 'claude-opus-4-8');
});

test('set_model with a value NOT in the catalog posts ok:false and never calls setModel', async () => {
  const cf = makeCf();
  const h = harness(cf);
  h.dispatch({ type: 'claudedeck_cmd', op: 'set_model', value: 'claude-sonnet-5' });
  await h.tick();
  assert.equal(cf.calls.length, 0, 'no near-miss setModel call');
  const r = h.results().at(-1);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not-in-catalog/);
});

test('set_model reports ok:false when the backend rejects (rollback, not a lying ack)', async () => {
  const cf = makeCf({ accept: () => false }); // backend rejects everything
  const h = harness(cf);
  h.dispatch({ type: 'claudedeck_cmd', op: 'set_model', value: 'claude-opus-4-8' });
  await h.tick();
  const r = h.results().at(-1);
  assert.equal(r.op, 'set_model');
  assert.equal(r.ok, false, 'result reflects the rollback');
  assert.equal(cf.modelSelection.value, 'claude-fable-5[1m]', 'rolled back');
});

test('results echo the command id so the dial can correlate acks (confirmed phase)', async () => {
  const cf = makeCf();
  const h = harness(cf);
  h.dispatch({ type: 'claudedeck_cmd', op: 'set_model', value: 'claude-opus-4-8', id: 7 });
  await h.tick();
  assert.equal(h.results().at(-1).id, 7);
  h.dispatch({ type: 'claudedeck_cmd', op: 'set_model', value: 'nope', id: 8 });
  await h.tick();
  assert.equal(h.results().at(-1).id, 8, 'not-in-catalog result carries the id too');
});

test('set_effort mirrors the level to the picker via setEffortLevel and acks (legacy disable_ultracode too)', async () => {
  const cf = makeCf();
  cf.ultracodeEnabled.set(true);
  cf.setEffortLevel = (l) => { cf.effortLevel.set(l); cf.ultracodeEnabled.set(false); };
  const h = harness(cf);
  h.dispatch({ type: 'claudedeck_cmd', op: 'set_effort', value: 'max', id: 9 });
  await h.tick();
  const r = h.results().at(-1);
  assert.equal(r.op, 'set_effort');
  assert.equal(r.ok, true);
  assert.equal(r.id, 9);
  assert.equal(cf.ultracodeEnabled.value, false, 'flag cleared via setEffortLevel');
  assert.equal(cf.effortLevel.value, 'max', 'picker now displays the dialed level');

  // auto passes undefined through (mirrors the key removal instead of forcing a level)
  h.dispatch({ type: 'claudedeck_cmd', op: 'set_effort', id: 10 });
  await h.tick();
  assert.equal(cf.effortLevel.value, undefined);

  // pre-v5 plugins still speak disable_ultracode — same handler
  h.dispatch({ type: 'claudedeck_cmd', op: 'disable_ultracode', value: 'high', id: 11 });
  await h.tick();
  assert.equal(h.results().at(-1).op, 'disable_ultracode');
  assert.equal(cf.effortLevel.value, 'high');
});

test('compact op submits "/compact" through the real send() method (not a nonexistent compact())', async () => {
  const cf = makeCf();
  assert.equal(cf.compact, undefined, 'the live Cf has no compact() — the old bridge called a ghost');
  const h = harness(cf);
  h.dispatch({ type: 'claudedeck_cmd', op: 'compact', id: 'model:5' });
  await h.tick();
  assert.deepEqual(cf.sent.map((s) => s.text), ['/compact'], 'exactly the /compact slash command is submitted');
  assert.equal(cf.sent[0].attachments, undefined, 'no attachments (wbe guards if(t))');
  const r = h.results().at(-1);
  assert.equal(r.op, 'compact');
  assert.equal(r.ok, true);
  assert.equal(r.id, 'model:5');
});

test('snapshot modelLabel falls back to displayName (live descriptors have no .label)', () => {
  const cf = makeCf();
  const h = harness(cf);
  assert.equal(h.states().at(-1).modelLabel, 'Fable 5 (1M context)');
});

test('snapshot reads the REAL running model (currentMainLoopModel), not the stale picker', () => {
  const cf = makeCf({ models: [
    { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-4-8[1m]' },
    { value: 'opus[1m]', displayName: 'Opus', resolvedModel: 'claude-opus-4-8[1m]' },
    { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
  ] });
  // picker (modelSelection) is stale on sonnet, but the session actually runs Opus
  cf.modelSelection.set('sonnet');
  cf.currentMainLoopModel.set('claude-opus-4-8[1m]');
  const h = harness(cf);
  const s = h.states().at(-1);
  assert.equal(s.modelEffective, 'claude-opus-4-8[1m]', 'shows the running model, not the picker');
  assert.equal(s.modelResolved, 'claude-opus-4-8[1m]');
  assert.equal(s.modelActive, 'opus[1m]', 'maps to a concrete catalog value (not the default alias) for browse');
  assert.equal(s.modelOverride, 'sonnet', 'the stale picker value is still relayed for reference');
});

test('snapshot relays resolvedModel — per catalog row; falls back to currentModelInfo when no main-loop model', () => {
  const cf = makeCf();
  cf.currentMainLoopModel.set(null); // backend model not yet known -> fall back to the picker descriptor
  cf.currentModelInfo.set({ value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-4-8[1m]' });
  const h = harness(cf);
  const s = h.states().at(-1);
  assert.equal(s.modelResolved, 'claude-opus-4-8[1m]', 'the concrete slug behind the default row');
  const def = s.catalog.find((m) => m.value === 'default');
  assert.equal(def.resolved, 'claude-opus-4-8[1m]');
  assert.equal(s.catalog.find((m) => m.value === 'claude-opus-4-8').resolved, null, 'rows without resolvedModel relay null');
});

test('unknown/undriveable ops still ack ok:false with the id (nothing vanishes silently)', async () => {
  const cf = makeCf();
  const h = harness(cf);
  h.dispatch({ type: 'claudedeck_cmd', op: 'frobnicate', id: 11 });
  await h.tick();
  const r = h.results().at(-1);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unhandled');
  assert.equal(r.id, 11);
});

test('rebind A→B→A does not duplicate subscriptions (no snap storms)', () => {
  const cfA = makeCf();
  const cfB = makeCf();
  const store = { activeSession: signal(cfA) };
  const posts = [];
  const sandbox = {
    window: { acquireVsCodeApi: () => ({ postMessage: (m) => posts.push(m) }), addEventListener: () => {} },
    setTimeout: () => 0,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(W_BRIDGE, sandbox);
  sandbox.__cdAttach(store);
  store.activeSession.set(cfB);
  store.activeSession.set(cfA); // back — pre-fix this re-subscribed A's signals a 2nd time
  const before = posts.filter((p) => p.kind === 'state').length;
  cfA.summary.set('renamed');   // ONE signal change
  const after = posts.filter((p) => p.kind === 'state').length;
  assert.equal(after - before, 1, 'exactly one snapshot per signal change after rebinds');
});

test('resync still snapshots; snapshot model reflects a successful set_model', async () => {
  const cf = makeCf();
  const h = harness(cf);
  h.dispatch({ type: 'claudedeck_cmd', op: 'set_model', value: 'claude-opus-4-8' });
  await h.tick();
  h.flushTimers();
  h.dispatch({ type: 'claudedeck_cmd', op: 'resync' });
  const s = h.states().at(-1);
  assert.equal(s.modelOverride, 'claude-opus-4-8');
});
