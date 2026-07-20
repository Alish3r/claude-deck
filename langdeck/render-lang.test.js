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

// --- configurable per-language colours (#36) ---

test('override colours reach the rendered face', () => {
  const s = renderLangSvg({ label: 'EN', state: 'ok', colours: { EN: '#7a5cff' } });
  assert.match(s, /fill="#7a5cff"/, 'the chosen background is painted');
  assert.doesNotMatch(s, /#1e3a5f/, 'the pinned default is gone once overridden');
});

test('a pale override gets dark ink so the label stays legible', () => {
  const pale = renderLangSvg({ label: 'EN', state: 'ok', colours: { EN: '#ffffff' } });
  assert.match(pale, /fill="#ffffff"/);
  assert.match(pale, /fill="#141518">EN</, 'dark ink on a white key');
  const dark = renderLangSvg({ label: 'EN', state: 'ok', colours: { EN: '#101010' } });
  assert.match(dark, /fill="#eaf1f8">EN</, 'light ink on a near-black key');
});

test('no colours setting renders byte-identically to before the feature', () => {
  for (const state of ['ok', 'single', 'warn', 'unknown', 'starting']) {
    for (const label of ['EN', 'RU', 'DE', null]) {
      const bare = renderLangSvg({ label, state });
      assert.equal(renderLangSvg({ label, state, colours: null }), bare, `${label}/${state}`);
      assert.equal(renderLangSvg({ label, state, colours: {} }), bare, `${label}/${state} empty map`);
      assert.equal(renderLangSvg({ label, state, colours: { XX: '#ff0000' } }), bare,
        `${label}/${state} unrelated override`);
    }
  }
});

test('a garbage colours value does not throw or leak into the SVG', () => {
  for (const bad of ['nope', 42, ['#fff'], { EN: 'red' }, { EN: null }]) {
    const s = renderLangSvg({ label: 'EN', state: 'ok', colours: bad });
    assert.match(s, /fill="#1e3a5f"/, `${JSON.stringify(bad)} falls back to the default`);
    assert.doesNotMatch(s, /undefined|null|NaN/);
  }
});

test('an overridden warn face keeps the warn dot and its own colour', () => {
  const s = renderLangSvg({ label: 'RU', state: 'warn', colours: { RU: '#0b6b3a' } });
  assert.match(s, /fill="#0b6b3a"/);
  assert.match(s, /id="warn"[^>]*fill="#e6864a"/, 'WARN semantics are untouched by #36');
});

test('an overridden single-layout face keeps the dimmed opacity', () => {
  const s = renderLangSvg({ label: 'EN', state: 'single', colours: { EN: '#7a5cff' } });
  assert.match(s, /opacity="0.45"/, 'DIM/single semantics are untouched by #36');
  assert.match(s, /fill="#7a5cff"/);
});
