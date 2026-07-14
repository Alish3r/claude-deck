// Webview bridge tests — fake preact-style signals + a controllable scheduler.
// No running webview. Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebviewBridge } from './webview/bridge.js';

// preact-like signal: subscribe fires immediately, then on every set().
function signal(v) {
  const subs = new Set();
  return {
    get value() { return v; },
    set(nv) { v = nv; for (const f of [...subs]) f(nv); },
    subscribe(fn) { subs.add(fn); fn(v); return () => subs.delete(fn); },
    _subs: subs,
  };
}

function makeCf(o = {}) {
  return {
    sessionId: signal(o.sessionId || 'S1'),
    modelSelection: signal(o.model || 'claude-fable-5'),
    currentModelInfo: signal({ value: o.model || 'claude-fable-5', label: o.label || 'Fable' }),
    effortLevel: signal(o.effort || 'xhigh'),
    ultracodeEnabled: signal(o.ultracode || false),
    thinkingLevelOverride: signal(o.thinking || 'off'),
    started: signal(o.started !== undefined ? o.started : true),
    claudeConfig: { models: o.catalog || [{ value: 'claude-fable-5', label: 'Fable' }, { value: 'claude-haiku-4-5', label: 'Haiku' }] },
    setModel(desc) { this.modelSelection.set(desc.value); this.currentModelInfo.set({ value: desc.value, label: desc.value }); return true; },
    setThinkingLevel(l) { this.thinkingLevelOverride.set(l); },
    enableUltracode() { this.ultracodeEnabled.set(true); },
    setEffortLevel(l) { this.effortLevel.set(l); },
  };
}

function harness({ cf = makeCf(), patchVersion = 1 } = {}) {
  const store = { activeSession: signal(cf) };
  const posts = [];
  const queue = [];
  const schedule = (fn) => queue.push(fn);
  const flush = () => { while (queue.length) queue.shift()(); };
  const bridge = createWebviewBridge({ store, post: (m) => posts.push(m), patchVersion, schedule });
  return { store, cf, posts, flush, bridge, states: () => posts.filter((p) => p.kind === 'state'), results: () => posts.filter((p) => p.kind === 'result') };
}

test('attach binds one Cf, says hello, and emits an initial snapshot with catalog', () => {
  const h = harness();
  h.bridge.attach();
  assert.ok(h.posts.some((p) => p.kind === 'hello'), 'hello posted');
  h.flush();
  const s = h.states().at(-1);
  assert.equal(s.sessionId, 'S1');
  assert.equal(s.modelOverride, 'claude-fable-5');
  assert.deepEqual(s.catalog.map((m) => m.value), ['claude-fable-5', 'claude-haiku-4-5']);
});

test('snapshots are coalesced: many signal changes in a batch => one snapshot', () => {
  const h = harness();
  h.bridge.attach();
  h.flush();
  const before = h.states().length;
  h.cf.modelSelection.set('claude-haiku-4-5');
  h.cf.effortLevel.set('low');
  h.cf.ultracodeEnabled.set(true);
  h.flush();
  assert.equal(h.states().length - before, 1, 'three changes coalesced into one snapshot');
});

test('exactly one Cf bound: re-emitting the same Cf does not double-subscribe', () => {
  const h = harness();
  h.bridge.attach();
  h.flush();
  const subCount = h.cf.modelSelection._subs.size;
  h.store.activeSession.set(h.cf); // same Cf again (spurious rerender)
  assert.equal(h.cf.modelSelection._subs.size, subCount, 'no extra subscription on same Cf');
});

test('rerender: binds the new Cf, drops the old one', () => {
  const h = harness();
  h.bridge.attach();
  h.flush();
  const cfB = makeCf({ sessionId: 'S1', model: 'claude-haiku-4-5' });
  h.store.activeSession.set(cfB); // rerender produced a new view-model
  h.flush();
  const n = h.states().length;

  h.cf.modelSelection.set('changed-old');   // old Cf must be unsubscribed
  h.flush();
  assert.equal(h.states().length, n, 'old Cf no longer produces snapshots');

  cfB.modelSelection.set('claude-fable-5');  // new Cf drives snapshots
  h.flush();
  const s = h.states().at(-1);
  assert.equal(s.modelOverride, 'claude-fable-5');
  assert.equal(h.cf.modelSelection._subs.size, 0, 'old Cf fully unsubscribed');
});

test('set_model: two-phase ack (accepted then confirmed) and the model changes', () => {
  const h = harness();
  h.bridge.attach();
  h.flush();
  h.bridge.handleCommand({ op: 'set_model', value: 'claude-haiku-4-5', id: 11 });
  // accepted is posted synchronously
  const acc = h.results().find((r) => r.id === 11 && r.phase === 'accepted');
  assert.ok(acc && acc.ok, 'accepted ok');
  assert.equal(h.results().some((r) => r.id === 11 && r.phase === 'confirmed'), false, 'not confirmed before flush');
  h.flush();
  const conf = h.results().find((r) => r.id === 11 && r.phase === 'confirmed');
  assert.ok(conf && conf.ok, 'confirmed after the signal echoes');
  assert.equal(h.cf.modelSelection.value, 'claude-haiku-4-5');
});

test('set_model rejects a model not in the catalog (accepted ok:false, no drive)', () => {
  const h = harness();
  h.bridge.attach();
  h.flush();
  const before = h.cf.modelSelection.value;
  h.bridge.handleCommand({ op: 'set_model', value: 'not-a-real-model', id: 5 });
  const acc = h.results().find((r) => r.id === 5 && r.phase === 'accepted');
  assert.equal(acc.ok, false);
  assert.equal(acc.error, 'not in catalog');
  assert.equal(h.cf.modelSelection.value, before, 'model unchanged');
  h.flush();
  assert.equal(h.results().some((r) => r.id === 5 && r.phase === 'confirmed'), false, 'never confirms');
});

test('set_model on a not-started chat is guarded (no launch, no throw)', () => {
  const h = harness({ cf: makeCf({ started: false }) });
  h.bridge.attach();
  h.flush();
  h.bridge.handleCommand({ op: 'set_model', value: 'claude-haiku-4-5', id: 1 });
  const acc = h.results().find((r) => r.id === 1 && r.phase === 'accepted');
  assert.equal(acc.ok, false);
  assert.equal(acc.error, 'not started');
});

test('toggle_thinking flips off<->default_on with two-phase ack', () => {
  const h = harness();
  h.bridge.attach();
  h.flush();
  h.bridge.handleCommand({ op: 'toggle_thinking', id: 2 });
  h.flush();
  assert.equal(h.cf.thinkingLevelOverride.value, 'default_on');
  assert.ok(h.results().find((r) => r.id === 2 && r.phase === 'confirmed'));
});

test('enable_ultracode (dial max) sets ultracode with two-phase ack', () => {
  const h = harness();
  h.bridge.attach();
  h.flush();
  h.bridge.handleCommand({ op: 'enable_ultracode', id: 9 });
  h.flush();
  assert.equal(h.cf.ultracodeEnabled.value, true);
  assert.ok(h.results().find((r) => r.id === 9 && r.phase === 'confirmed'));
});

test('every snapshot and ack is stamped with patchVersion', () => {
  const h = harness({ patchVersion: 7 });
  h.bridge.attach();
  h.flush();
  h.bridge.handleCommand({ op: 'set_model', value: 'claude-haiku-4-5', id: 3 });
  h.flush();
  assert.ok(h.posts.length > 0);
  for (const p of h.posts) assert.equal(p.patchVersion, 7, `post ${p.kind}/${p.phase || ''} stamped`);
});

test('no active chat => command is rejected, not thrown', () => {
  const store = { activeSession: signal(null) };
  const posts = [];
  const bridge = createWebviewBridge({ store, post: (m) => posts.push(m), schedule: (fn) => fn() });
  bridge.attach();
  const r = bridge.handleCommand({ op: 'set_model', value: 'x', id: 1 });
  assert.equal(r.ok, false);
  assert.equal(posts.find((p) => p.id === 1).error, 'no active chat');
});
