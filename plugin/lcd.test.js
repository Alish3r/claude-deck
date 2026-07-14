// LCD render tests — pure, no hardware. Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, marquee, overflows, modelShort, effortLabel, effortPct, toFeedback, LCD_KEYS } from './src/lcd.js';

test('marquee: static when it fits, scrolls when it overflows', () => {
  assert.equal(marquee('short', 0, 14), 'short');
  assert.equal(overflows('short', 14), false);
  const long = 'window-A ▸ session-1234567';
  assert.equal(overflows(long, 14), true);
  const a = marquee(long, 0, 14);
  const b = marquee(long, 3, 14);
  assert.equal(a.length, 14);
  assert.notEqual(a, b, 'offset changes the visible window');
});

test('modelShort derives a readable label and prefers modelLabel', () => {
  assert.equal(modelShort({ model: 'claude-fable-5[1m]' }), 'Fable 5');
  assert.equal(modelShort({ model: 'claude-haiku-4-5' }), 'Haiku 4 5');
  assert.equal(modelShort({ model: 'x', modelLabel: 'Opus 4.8' }), 'Opus 4.8');
  assert.equal(modelShort({ model: null }), 'Default');
});

test('effort label + gauge percent across the ladder', () => {
  assert.equal(effortLabel(null), 'Auto');
  assert.equal(effortLabel('auto'), 'Auto');
  assert.equal(effortLabel('xhigh'), 'xhigh');
  assert.equal(effortPct('auto'), 0, 'display-only state: gauge floor');
  assert.equal(effortPct('ultracode'), 100);
  assert.equal(effortPct('high'), 40); // index 2 of 0..5
  assert.equal(effortPct('max'), 80); // index 4 of 0..5
  assert.equal(effortPct(null), 0);
});

test('sentinels render distinct LCD states', () => {
  assert.equal(render('model', { kind: 'no-vscode' }).state, 'no-vscode');
  assert.equal(render('model', { kind: 'no-vscode' }).value, 'No VS Code');
  assert.equal(render('model', { kind: 'no-chat' }).state, 'no-chat');
  assert.equal(render('model', { kind: 'not-started', windowId: 'A', sessionId: 's1' }).state, 'not-started');
});

test('model dial (ok): shows chat name + model, hides gauge', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', summary: 'auth-refactor', model: 'claude-fable-5[1m]', modelLabel: null, effort: 'xhigh' };
  const r = render('model', ts, {});
  assert.equal(r.state, 'ok');
  assert.equal(r.value, 'Fable 5');
  assert.equal(r.indicator, -1, 'model dial hides the gauge');
  assert.match(r.title, /auth-refactor/, 'title prefers the chat summary (real name)');
});

test('model dial: chat label falls back to sessionId when no summary', () => {
  const r = render('model', { kind: 'ok', sessionId: 's1', model: 'claude-opus-4-8' }, {});
  assert.match(r.title, /s1/);
});

test('model dial: busy chat keeps its model visible with a spinner (busy ≠ compacting)', () => {
  const ts = { kind: 'ok', sessionId: 's1', summary: 'big-chat', model: 'claude-opus-4-8', busy: true };
  const r = render('model', ts, {});
  assert.equal(r.state, 'busy');
  assert.equal(r.value, 'Opus 4 8');
  assert.equal(r.icon, 'spinner');
});

test('model dial: the compacting screen appears only for the explicit compact phase', () => {
  const ts = { kind: 'ok', sessionId: 's1', summary: 'big-chat', model: 'claude-opus-4-8', busy: false };
  const r = render('model', ts, { phase: 'compacting' });
  assert.equal(r.state, 'compacting');
  assert.equal(r.value, 'Compacting');
  assert.equal(r.icon, 'spinner');
});

test('model dial: an active browse is never masked by busy', () => {
  const ts = { kind: 'ok', sessionId: 's1', model: 'claude-opus-4-8', busy: true };
  const r = render('model', ts, { phase: 'browsing', browseValue: 'claude-sonnet-5' });
  assert.equal(r.state, 'browsing');
  assert.equal(r.value, 'Sonnet 5');
});

test('effort dial (ok): ⊙GLOBAL marquee + level + gauge', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'high' };
  const r = render('effort', ts, {});
  assert.match(r.title, /GLOBAL/);
  assert.equal(r.value, 'high');
  assert.equal(r.indicator, 40);
});

test('browsing shows the browse value; applying/confirmed/error set the glyph', () => {
  const ts = { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'low', model: 'claude-fable-5' };
  assert.equal(render('effort', ts, { phase: 'browsing', browseValue: 'ultracode' }).value, 'ultracode');
  assert.equal(render('effort', ts, { phase: 'browsing', browseValue: 'ultracode' }).indicator, 100);
  assert.equal(render('model', ts, { phase: 'applying' }).icon, 'spinner');
  assert.equal(render('model', ts, { phase: 'confirmed' }).icon, 'ok');
  assert.equal(render('model', ts, { phase: 'error' }).icon, 'warn');
  assert.equal(render('effort', ts, { phase: 'reload-needed' }).state, 'reload-needed');
});

test('toFeedback maps to layout item keys and omits a hidden gauge', () => {
  const fbModel = toFeedback(render('model', { kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5' }, {}));
  assert.ok(LCD_KEYS.title in fbModel && LCD_KEYS.value in fbModel && LCD_KEYS.icon in fbModel);
  assert.equal(LCD_KEYS.indicator in fbModel, false, 'gauge omitted when hidden (indicator -1)');
  const fbEffort = toFeedback(render('effort', { kind: 'ok', windowId: 'A', sessionId: 's1', effort: 'high' }, {}));
  assert.equal(fbEffort[LCD_KEYS.indicator], 40);
});
