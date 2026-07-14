// Dial action controller + browse tests — no @elgato, no hardware. Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseModel, browseEffort } from './src/browse.js';
import { createDialAction } from './src/action-logic.js';

function fakeTimers() {
  const q = new Map(); let id = 0;
  return { setTimer: (fn) => { const i = ++id; q.set(i, fn); return i; }, clearTimer: (i) => q.delete(i), run: () => { const f = [...q.values()]; q.clear(); f.forEach((x) => x()); } };
}
const CATALOG = [{ value: 'claude-fable-5', label: 'Fable' }, { value: 'claude-haiku-4-5', label: 'Haiku' }, { value: 'claude-opus-4-8', label: 'Opus' }];

// --- browse ---

test('browseModel wraps around the catalog', () => {
  assert.equal(browseModel(CATALOG, 'claude-fable-5', 1), 'claude-haiku-4-5');
  assert.equal(browseModel(CATALOG, 'claude-opus-4-8', 1), 'claude-fable-5', 'wrap forward');
  assert.equal(browseModel(CATALOG, 'claude-fable-5', -1), 'claude-opus-4-8', 'wrap backward');
});

test('browseEffort clamps along the ladder (no wrap)', () => {
  assert.equal(browseEffort('auto', 1), 'low');
  assert.equal(browseEffort('auto', -1), 'auto', 'clamped at bottom');
  assert.equal(browseEffort('max', 1), 'max', 'clamped at top');
  assert.equal(browseEffort('xhigh', 1), 'max');
  assert.equal(browseEffort(null, 1), 'low');
});

// --- action controller ---

function rig({ dial, ts }) {
  const t = fakeTimers();
  const sent = []; const feedback = []; const efforts = [];
  const hub = { sendToTarget: (c) => sent.push(c), targetState: () => ts };
  const a = createDialAction({
    dial, hub, setFeedback: (f) => feedback.push(f), setEffort: (l) => efforts.push(l),
    setTimer: t.setTimer, clearTimer: t.clearTimer,
  });
  return { a, t, sent, feedback, efforts };
}

test('model dial: rotate browses catalog, debounced apply -> hub set_model with id=seq', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', catalog: CATALOG };
  const { a, t, sent, feedback } = rig({ dial: 'model', ts });
  a.onRotate(1);
  assert.equal(a.browseValue, 'claude-haiku-4-5');
  assert.equal(sent.length, 0, 'nothing sent mid-browse');
  assert.match(feedback.at(-1).value, /Haiku/, 'LCD shows the browse value');
  t.run(); // debounce fires
  assert.equal(sent.length, 1);
  assert.deepEqual({ op: sent[0].op, value: sent[0].value }, { op: 'set_model', value: 'claude-haiku-4-5' });
  assert.equal(typeof sent[0].id, 'number', 'command carries a seq id');
});

test('effort dial: rotate writes ⊙GLOBAL settings locally (not a webview cmd)', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'low' };
  const { a, t, sent, efforts } = rig({ dial: 'effort', ts });
  a.onRotate(1); // low -> medium
  assert.equal(a.browseValue, 'medium');
  t.run();
  assert.deepEqual(efforts, ['medium'], 'setEffort called with the level');
  assert.equal(sent.length, 0, 'no webview command for a plain effort level');
});

test('effort dial max: writes xhigh-equivalent locally AND sends enable_ultracode', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'xhigh' };
  const { a, t, sent, efforts } = rig({ dial: 'effort', ts });
  a.onRotate(1); // xhigh -> max
  assert.equal(a.browseValue, 'max');
  t.run();
  assert.deepEqual(efforts, ['max']);
  assert.equal(sent[0].op, 'enable_ultracode');
});

test('press: model resyncs, effort toggles thinking', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', effort: 'low', catalog: CATALOG };
  const m = rig({ dial: 'model', ts }); m.a.onPress();
  assert.equal(m.sent[0].op, 'resync');
  const e = rig({ dial: 'effort', ts }); e.a.onPress();
  assert.equal(e.sent[0].op, 'toggle_thinking');
});

test('onResult confirmed paints the check glyph', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', catalog: CATALOG };
  const { a, t, feedback } = rig({ dial: 'model', ts });
  a.onRotate(1); t.run(); // seq 1 in flight
  a.onResult({ id: 1, ok: true });
  assert.equal(feedback.at(-1).icon, 'ok');
});
