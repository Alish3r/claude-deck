// Key-face renderer tests — pure SVG string generation, no sharp/rasterization needed.
// Run: cd plugin && node --test render-lang.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLangSvg } from './src/render-lang.js';

test('normal state: label text on the language colour', () => {
  const s = renderLangSvg({ label: 'EN', state: 'ok' });
  assert.match(s, /viewBox="0 0 72 72"/);
  assert.match(s, /#1e3a5f/, 'EN uses the locked slate background');
  assert.match(s, />EN</, 'label is rendered as text');
  assert.doesNotMatch(s, /id="warn"/, 'no warn dot in the ok state');
});

test('RU renders the locked clay background', () => {
  assert.match(renderLangSvg({ label: 'RU', state: 'ok' }), /#d97757/);
});

test('dimmed state: unknown language shows a dash, not a stale label', () => {
  const s = renderLangSvg({ label: null, state: 'unknown' });
  assert.match(s, />—</, 'em dash placeholder');
  assert.match(s, /#8794a4/, 'dim ink');
  assert.doesNotMatch(s, />EN</);
});

test('starting state: ellipsis placeholder while the co-process boots', () => {
  const s = renderLangSvg({ label: null, state: 'starting' });
  assert.match(s, />…</);
  assert.match(s, /#8794a4/);
});

test('single-layout state: shows the label but dimmed, since pressing does nothing', () => {
  const s = renderLangSvg({ label: 'EN', state: 'single' });
  assert.match(s, />EN</);
  assert.match(s, /opacity="0\.45"/, 'dimmed to signal the press is a no-op');
});

test('warn state: label still truthful, plus a warn dot (elevated-window case)', () => {
  const s = renderLangSvg({ label: 'EN', state: 'warn' });
  assert.match(s, />EN</, 'never hides the real language');
  assert.match(s, /id="warn"/);
  assert.match(s, /#e6864a/);
});

test('long labels shrink so a 3-char fallback code still fits the key', () => {
  const two = renderLangSvg({ label: 'EN', state: 'ok' });
  const three = renderLangSvg({ label: '3F', state: 'ok' });
  assert.match(two, /font-size="34"/);
  assert.match(three, /font-size="34"/);
  const four = renderLangSvg({ label: 'ABCD', state: 'ok' });
  assert.match(four, /font-size="24"/, 'longer codes use a smaller face');
});

test('label is XML-escaped so it can never break the SVG', () => {
  const s = renderLangSvg({ label: 'A&B', state: 'ok' });
  assert.match(s, /A&amp;B/);
  assert.doesNotMatch(s, /A&B/);
});
