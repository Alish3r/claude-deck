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

test('browse honors rotation MAGNITUDE — a batched multi-detent tick moves that many steps', () => {
  // CATALOG order: fable(0), haiku(1), opus(2)
  assert.equal(browseModel(CATALOG, 'claude-fable-5', 1), 'claude-haiku-4-5', '1 detent = 1 step');
  assert.equal(browseModel(CATALOG, 'claude-fable-5', 2), 'claude-opus-4-8', '2 detents = 2 steps, not 1');
  assert.equal(browseEffort('low', 3), 'xhigh', 'low +3 rungs = xhigh (clamped ladder)');
  assert.equal(browseEffort('low', 99), 'ultracode', 'overshoot clamps at the top');
  assert.equal(browseEffort('max', -2), 'high');
});

test('browseEffort clamps along the ladder (no wrap); auto/unknown anchors at low', () => {
  assert.equal(browseEffort('auto', 1), 'low', 'unset settings: first tick lands on the bottom rung');
  assert.equal(browseEffort('auto', -1), 'low', 'no dialable auto — clamped at low');
  assert.equal(browseEffort('banana', 1), 'low', 'junk settings value anchors at low too');
  assert.equal(browseEffort('low', -1), 'low', 'clamped at bottom');
  assert.equal(browseEffort('ultracode', 1), 'ultracode', 'clamped at top');
  assert.equal(browseEffort('xhigh', 1), 'max');
  assert.equal(browseEffort('max', 1), 'ultracode');
  assert.equal(browseEffort('max', -1), 'xhigh');
  assert.equal(browseEffort(null, 1), 'low');
});

// --- action controller ---

function rig({ dial, ts }) {
  const t = fakeTimers();
  const sent = []; const feedback = []; const efforts = [];
  const clock = { ms: 10000 }; // injected nowMs, advance via clock.ms for time-bounded holds
  const hub = { sendToTarget: (c) => sent.push(c), targetState: () => ts };
  const a = createDialAction({
    dial, hub, setFeedback: (f) => feedback.push(f), setEffort: (l) => efforts.push(l),
    setTimer: t.setTimer, clearTimer: t.clearTimer, nowMs: () => clock.ms,
  });
  return { a, t, sent, feedback, efforts, clock };
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
  assert.equal(sent[0].id, 'model:1', 'command carries a dial-namespaced seq id');
});

test('model dial: after a change, the NEXT single click continues from the held pick (not the stale bridge model)', () => {
  // Regression from the held-model fix: the bridge's modelActive lags a fresh set, so anchoring
  // rotation at it made the first click after a change re-land on the model already shown
  // ("one click does nothing; need a 2-3 click spin"). Anchor at the held (displayed) model instead.
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', modelActive: 'claude-fable-5', catalog: CATALOG };
  const { a, t } = rig({ dial: 'model', ts });
  a.onRotate(1); t.run();                       // fable -> haiku, applied; held=haiku; bridge STILL fable
  a.onRotate(1);                                // a slow single click later
  assert.equal(a.browseValue, 'claude-opus-4-8', 'continues haiku -> opus, not re-landing on haiku');
});

test('model dial: after a confirmed set, an idle repaint HOLDS the applied model until the bridge catches up (no flash-back to the old model)', () => {
  // Regression: rotating set_model updates the picker but currentMainLoopModel (→ targetState.model)
  // lags until a turn runs. The old code let a phase:'ok' repaint (tick/onUpdate) flash back to the
  // stale targetState.model. Bridge still reports the OLD model (fable) via model + modelActive.
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', modelActive: 'claude-fable-5', catalog: CATALOG };
  const { a, t, feedback } = rig({ dial: 'model', ts });
  a.onRotate(2);                                    // fable -> opus (2 detents)
  t.run();                                          // debounce -> set_model opus
  a.onResult({ id: 'model:1', ok: true, requested: 'claude-opus-4-8' });
  assert.match(feedback.at(-1).value, /Opus/, 'shows the applied model right after confirm');
  a.onUpdate();                                     // background repaint, bridge STILL says fable
  assert.match(feedback.at(-1).value, /Opus/, 'HOLDS opus — does NOT flash back to fable');
  assert.doesNotMatch(feedback.at(-1).value, /Fable/, 'no stale old-model text');
  ts.model = 'claude-opus-4-8'; ts.modelActive = 'claude-opus-4-8';  // a turn ran; bridge caught up
  a.onUpdate();
  assert.match(feedback.at(-1).value, /Opus/, 'still opus, now from the bridge (hold released)');
});

test('model dial: a failed (rolled-back) set does NOT stick — display returns to the real model', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', modelActive: 'claude-fable-5', catalog: CATALOG };
  const { a, t, feedback } = rig({ dial: 'model', ts });
  a.onRotate(2); t.run();
  a.onResult({ id: 'model:1', ok: false, requested: 'claude-opus-4-8' }); // rollback / not-in-catalog
  a.onUpdate();
  assert.match(feedback.at(-1).value, /Fable/, 'no hold on a failed set — shows the real (unchanged) model');
});

test('effort dial: rotate writes ⊙GLOBAL settings locally AND mirrors to the picker', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'low' };
  const { a, t, sent, efforts } = rig({ dial: 'effort', ts });
  a.onRotate(1); // low -> medium
  assert.equal(a.browseValue, 'medium');
  t.run();
  assert.deepEqual(efforts, ['medium'], 'setEffort called with the level (settings.json stays the authority)');
  assert.equal(sent[0].op, 'set_effort', 'display mirror: the focused chat picker follows the dial');
  assert.equal(sent[0].value, 'medium');
});

test('effort dial: after a change, an idle repaint HOLDS the applied level over the mirror window', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'low', effortGlobal: 'low' };
  const { a, t, feedback } = rig({ dial: 'effort', ts });
  a.onRotate(2); t.run();                                  // low -> high, applied; bridge STILL low
  assert.match(feedback.at(-1).value, /high/, 'confirmed shows the applied level');
  a.onUpdate();
  assert.match(feedback.at(-1).value, /high/, 'HOLDS high — does not flash back to low');
  assert.doesNotMatch(feedback.at(-1).value, /low/, 'no stale low');
  ts.effort = 'high';                                      // chat signal catches up (mirror propagated)
  a.onUpdate();
  assert.match(feedback.at(-1).value, /high/, 'still high, now from the bridge (hold released)');
});

test('effort hold is time-bounded — expires so a failed mirror can never wedge it', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'low', effortGlobal: 'low' };
  const { a, t, feedback, clock } = rig({ dial: 'effort', ts });
  a.onRotate(2); t.run();                                  // held high, until = now + 2500
  a.onUpdate();
  assert.match(feedback.at(-1).value, /high/, 'held before expiry');
  clock.ms += 3000;                                        // past EFFORT_HOLD_MS; mirror never propagated
  a.onUpdate();
  assert.match(feedback.at(-1).value, /low/, 'hold expired — falls back to the bridge signal, never wedged');
});

test('effort dial: low is the floor — auto is not dialable (the picker has no Auto)', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'low' };
  const { a, t, sent, efforts } = rig({ dial: 'effort', ts });
  a.onRotate(-1); // below the bottom rung: clamps at low
  t.run();
  assert.deepEqual(efforts, ['low'], 'never writes auto/removes the key from the dial');
  assert.deepEqual(sent.map((c) => [c.op, c.value]), [['set_effort', 'low']]);
});

test('effort dial ultracode: writes xhigh-equivalent locally AND sends enable_ultracode', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'max' };
  const { a, t, sent, efforts } = rig({ dial: 'effort', ts });
  a.onRotate(1); // max -> ultracode
  assert.equal(a.browseValue, 'ultracode');
  t.run();
  assert.deepEqual(efforts, ['ultracode']);
  assert.equal(sent[0].op, 'enable_ultracode');
});

test('effort dial leaving ultracode: writes the level locally AND set_effort clears the flag', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'ultracode', ultracode: true };
  const { a, t, sent, efforts } = rig({ dial: 'effort', ts });
  a.onRotate(-1); // ultracode -> max
  assert.equal(a.browseValue, 'max');
  t.run();
  assert.deepEqual(efforts, ['max']);
  assert.equal(sent[0].op, 'set_effort', 'setEffortLevel is the only ultracode-off path AND the display mirror');
  assert.equal(sent[0].value, 'max');
});

test('effort dial between plain rungs: the mirror op still follows (picker tracks the dial)', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'high', ultracode: false };
  const { a, t, sent } = rig({ dial: 'effort', ts });
  a.onRotate(1); // high -> xhigh
  t.run();
  assert.deepEqual(sent.map((c) => [c.op, c.value]), [['set_effort', 'xhigh']]);
});

test('debounced apply targets the window captured at browse time, not focus-at-fire time', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', catalog: CATALOG };
  const { a, t, sent } = rig({ dial: 'model', ts });
  a.onRotate(1);                              // browse starts while window A is focused
  ts.windowId = 'B'; ts.sessionId = 's2';     // focus moves before the debounce fires
  t.run();
  assert.equal(sent[0].windowId, 'A', 'command pinned to the browsed window');
  assert.equal(sent[0].sessionId, 's1');
});

test('press defaults: model compacts (optimistic), effort toggles thinking', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', effort: 'low', catalog: CATALOG };
  const m = rig({ dial: 'model', ts }); m.a.onPress();          // no configured action → default
  assert.equal(m.sent[0].op, 'compact');
  assert.equal(m.feedback.at(-1)._raw.ui.phase, 'compacting', 'paints compacting immediately');
  const e = rig({ dial: 'effort', ts }); e.a.onPress();
  assert.equal(e.sent[0].op, 'toggle_thinking');
});

test('press is configurable per dial (property inspector setting)', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', effort: 'low', catalog: CATALOG };
  // model dial set to resync
  const mr = rig({ dial: 'model', ts }); mr.a.onPress('resync');
  assert.equal(mr.sent[0].op, 'resync', 'model press → resync when configured');
  assert.notEqual(mr.feedback.at(-1)._raw.ui.phase, 'compacting', 'resync is not a compacting paint');
  // effort dial set to resync
  const er = rig({ dial: 'effort', ts }); er.a.onPress('resync');
  assert.equal(er.sent[0].op, 'resync', 'effort press → resync when configured');
  // explicit compact / thinking still route
  const mc = rig({ dial: 'model', ts }); mc.a.onPress('compact');
  assert.equal(mc.sent[0].op, 'compact');
  const et = rig({ dial: 'effort', ts }); et.a.onPress('thinking');
  assert.equal(et.sent[0].op, 'toggle_thinking');
});

test('tick advances the compacting spinner only while the focused chat is busy', () => {
  const idleTs = { kind: 'ok', sessionId: 's1', model: 'claude-opus-4-8', busy: false, catalog: CATALOG };
  const idleRig = rig({ dial: 'model', ts: idleTs });
  idleRig.a.tick();
  assert.equal(idleRig.feedback.length, 0, 'no rasterize when not busy');

  const busyTs = { kind: 'ok', sessionId: 's1', model: 'claude-opus-4-8', busy: true, catalog: CATALOG };
  const busyRig = rig({ dial: 'model', ts: busyTs });
  busyRig.a.tick();
  const fb = busyRig.feedback.at(-1);
  assert.equal(typeof fb._raw.ui.spin, 'number', 'tick pushes a spin frame while busy');
});

test('effort dial tick is a no-op (only the model dial animates)', () => {
  const busyTs = { kind: 'ok', sessionId: 's1', effort: 'high', busy: true };
  const r = rig({ dial: 'effort', ts: busyTs });
  r.a.tick();
  assert.equal(r.feedback.length, 0);
});

test('onResult confirmed paints the check glyph', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', catalog: CATALOG };
  const { a, t, feedback } = rig({ dial: 'model', ts });
  a.onRotate(1); t.run(); // seq 1 in flight
  a.onResult({ id: 'model:1', ok: true, requested: 'claude-haiku-4-5' });
  assert.equal(feedback.at(-1).icon, 'ok');
});

test('effort dial ignores a mirror ok:false ack — a successful local setEffort is not overridden', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'high', ultracode: false };
  const { a, t, feedback } = rig({ dial: 'effort', ts });
  a.onRotate(1); t.run();              // setEffort succeeds locally -> apply() paints confirmed
  assert.equal(feedback.at(-1).icon, 'ok', 'local write confirmed');
  // the cosmetic set_effort mirror comes back ok:false (focused chat panel gone)
  a.onResult({ id: 'effort:1', ok: false, error: 'no-panel' });
  assert.equal(feedback.at(-1).icon, 'ok', 'mirror failure does NOT flip the dial to error');
});

test('onResult paints ERROR for an ok:false ack of the latest command (never a false confirm)', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', catalog: CATALOG };
  const { a, t, feedback } = rig({ dial: 'model', ts });
  a.onRotate(1); t.run();
  a.onResult({ id: 'model:1', ok: false, error: 'not-in-catalog' });
  assert.equal(feedback.at(-1).icon, 'warn');
});

test("the OTHER dial's ack with a colliding seq can never confirm ours", () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', catalog: CATALOG };
  const { a, t, feedback } = rig({ dial: 'model', ts });
  a.onRotate(1); t.run(); // model seq 1 in flight
  const before = feedback.length;
  a.onResult({ id: 'effort:1', ok: true });
  assert.equal(feedback.length, before, 'foreign-dial ack ignored entirely');
});

test('multi-detent turns advance one step per tick (anchor at the browse position)', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', catalog: CATALOG };
  const { a, t, sent } = rig({ dial: 'model', ts });
  a.onRotate(1); a.onRotate(1); // fable -> haiku -> opus (state never updated in between)
  t.run();
  assert.equal(sent[0].value, 'claude-opus-4-8', 'two ticks moved two steps');
});

test('tick scrolls an overflowing chat name even when the chat is idle (marquee runs)', () => {
  const long = 'auth-token-refresh-refactor-for-the-whole-service';
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', summary: long, busy: false, catalog: CATALOG };
  const { a, feedback } = rig({ dial: 'model', ts });
  const before = feedback.length;
  a.tick(); a.tick(); a.tick(); a.tick();
  assert.ok(feedback.length > before, 'overflowing title repaints on tick');
  const offs = feedback.slice(before).map((f) => f._raw.ui.marqueeOffset);
  assert.ok(offs.at(-1) > 0, 'marquee offset advances');
});

test('tick does NOT repaint an idle chat with a short title (never rasterizes idle)', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', summary: 'tiny', busy: false, catalog: CATALOG };
  const { a, feedback } = rig({ dial: 'model', ts });
  const before = feedback.length;
  a.tick(); a.tick(); a.tick();
  assert.equal(feedback.length, before);
});

test('rotation on a sentinel state neither browses nor writes', () => {
  const ts = { kind: 'no-vscode' };
  const { a, t, sent, efforts } = rig({ dial: 'effort', ts });
  a.onRotate(1); t.run();
  assert.equal(sent.length, 0);
  assert.deepEqual(efforts, [], 'no blind settings write while the LCD shows a sentinel');
});

test('enable then immediately dial down still leaves ultracode (set_effort is unconditional)', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'max', ultracode: false };
  const { a, t, sent, efforts } = rig({ dial: 'effort', ts });
  a.onRotate(1); t.run();   // max -> ultracode (enable sent)
  ts.effort = 'xhigh';      // settings write landed, but the state-file flag still lags false
  a.onRotate(-1); t.run();  // dial down — the mirror op needs no lag-prone flag check at all
  const ops = sent.map((c) => c.op);
  assert.deepEqual(ops, ['enable_ultracode', 'set_effort']);
  assert.equal(sent[1].value, efforts[1], 'mirror carries the level that was just applied');
});
