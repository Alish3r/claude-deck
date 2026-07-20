// Pure language logic — no PowerShell, no I/O, no rasterization.
// Run: cd plugin && node --test lang-logic.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHkl, primaryLangId, labelFor, colourFor, langFace,
  orderLayouts, nextLayout, parseStateLine,
  inkFor, normalizeHex, defaultBg, INK, DIM, INK_DARK,
} from './src/lang-logic.js';

test('normalizeHkl: uppercases and zero-pads to 8 hex chars', () => {
  assert.equal(normalizeHkl('4190419'), '04190419');
  assert.equal(normalizeHkl('04090409'), '04090409');
  assert.equal(normalizeHkl('0x04090409'), '04090409');
  assert.equal(normalizeHkl('a0000409'), 'A0000409');
  assert.equal(normalizeHkl(''), null);
  assert.equal(normalizeHkl(null), null);
});

test('primaryLangId: collapses sublanguages so en-US and en-GB are one language', () => {
  // low word = langid; low 10 bits = primary language
  assert.equal(primaryLangId('04090409'), 0x09); // en-US
  assert.equal(primaryLangId('08090809'), 0x09); // en-GB -> same primary
  assert.equal(primaryLangId('04190419'), 0x19); // ru-RU
  assert.equal(primaryLangId('A0000409'), 0x09); // Dvorak variant, still English
});

test('labelFor: known languages get two-letter codes, unknown falls back to hex', () => {
  assert.equal(labelFor('04090409'), 'EN');
  assert.equal(labelFor('08090809'), 'EN');
  assert.equal(labelFor('04190419'), 'RU');
  assert.equal(labelFor('04070407'), 'DE');
  // primary = langid & 0x3FF; 0x0003 is unmapped, so it falls back to zero-padded hex
  assert.equal(labelFor('00030003'), '03');
});

test('colourFor: EN and RU are the locked colours; anything else uses the existing neutral', () => {
  assert.equal(colourFor('EN').bg, '#1e3a5f');
  assert.equal(colourFor('RU').bg, '#d97757');
  assert.equal(colourFor('EN').ink, '#eaf1f8');
  // Out-of-scope languages get the plugin's existing neutral key colour, not an invented one.
  assert.equal(colourFor('DE').bg, '#141518');
  assert.equal(colourFor(null).bg, '#141518');
  assert.equal(colourFor(null).ink, '#8794a4', 'no known language dims the ink');
});

test('langFace: a dead co-process reports starting, never a stale language', () => {
  assert.deepEqual(langFace(null), { label: null, state: 'starting' });
  assert.deepEqual(langFace({ alive: false, hkl: '04090409', list: [] }), { label: null, state: 'starting' });
});

test('langFace: no foreground window reports unknown, not a guessed language', () => {
  assert.deepEqual(langFace({ alive: true, hkl: null, list: ['04090409'] }), { label: null, state: 'unknown' });
});

test('langFace: a single installed layout is dimmed because pressing is a no-op', () => {
  assert.deepEqual(langFace({ alive: true, hkl: '04090409', list: ['04090409'] }), { label: 'EN', state: 'single' });
});

test('langFace: warn wins over ok while the window is open, then expires', () => {
  const s = { alive: true, hkl: '04090409', list: ['04090409', '04190419'] };
  assert.equal(langFace(s, 1000, 500).state, 'warn', 'inside the warn window');
  assert.equal(langFace(s, 1000, 1500).state, 'ok', 'after it expires');
  assert.equal(langFace(s, 0, 1500).state, 'ok', 'no warn set');
  // the label stays TRUE even while warning — honesty over illusion
  assert.equal(langFace(s, 1000, 500).label, 'EN');
});

test('orderLayouts: Preload order wins over GetKeyboardLayoutList order', () => {
  // Real dev-machine data: the two sources DISAGREE.
  const list = ['04190419', '04090409'];          // GetKeyboardLayoutList order (RU, EN)
  const preload = ['00000409', '00000419'];        // HKCU\Keyboard Layout\Preload (EN, RU)
  assert.deepEqual(orderLayouts(list, preload), ['04090409', '04190419']);
});

test('orderLayouts: falls back to numeric sort when Preload is missing or unmatched', () => {
  const list = ['04190419', '04090409'];
  assert.deepEqual(orderLayouts(list, []), ['04090409', '04190419']);
  assert.deepEqual(orderLayouts(list, null), ['04090409', '04190419']);
  // partial match: matched entries keep Preload order and lead, rest sorted numerically
  assert.deepEqual(orderLayouts(['04190419', '04090409'], ['00000419']), ['04190419', '04090409']);
});

test('nextLayout: wraps from last back to first', () => {
  const ordered = ['04090409', '04190419'];
  assert.equal(nextLayout('04090409', ordered), '04190419');
  assert.equal(nextLayout('04190419', ordered), '04090409'); // wrap
});

test('nextLayout: current absent from list lands on the first entry, never throws', () => {
  const ordered = ['04090409', '04190419'];
  assert.equal(nextLayout('04070407', ordered), '04090409');
  assert.equal(nextLayout(null, ordered), '04090409');
});

test('nextLayout: single-layout and empty-list are safe no-ops', () => {
  assert.equal(nextLayout('04090409', ['04090409']), '04090409');
  assert.equal(nextLayout('04090409', []), null);
  assert.equal(nextLayout(null, []), null);
});

test('parseStateLine: splits the co-process wire format', () => {
  const s = parseStateLine('04090409|04190419,04090409|123456');
  assert.equal(s.hkl, '04090409');
  assert.deepEqual(s.list, ['04190419', '04090409']);
  assert.equal(s.hwnd, '123456');
});

test('parseStateLine: hwnd 0 (no foreground window) yields a null hkl', () => {
  const s = parseStateLine('00000000|04190419,04090409|0');
  assert.equal(s.hwnd, '0');
  assert.equal(s.hkl, null, 'no foreground window means no meaningful current layout');
});

test('parseStateLine: garbage returns null rather than throwing', () => {
  assert.equal(parseStateLine(''), null);
  assert.equal(parseStateLine('READY'), null);
  assert.equal(parseStateLine(null), null);
});

// --- configurable per-language colours (#36) ---

test('colourFor: an override map wins over the pinned default', () => {
  assert.equal(colourFor('EN', { EN: '#7a5cff' }).bg, '#7a5cff');
  assert.equal(colourFor('RU', { RU: '#0b6b3a' }).bg, '#0b6b3a');
});

test('colourFor: a language absent from the override map keeps its old face exactly', () => {
  const noSettings = colourFor('RU');
  const otherLangSet = colourFor('RU', { EN: '#7a5cff' });
  assert.deepEqual(otherLangSet, noSettings);
  assert.deepEqual(noSettings, { bg: '#d97757', ink: INK }, 'RU clay + INK, unchanged by #36');
  assert.deepEqual(colourFor('EN'), { bg: '#1e3a5f', ink: INK });
  assert.deepEqual(colourFor('DE'), { bg: '#141518', ink: INK }, 'unpinned falls back to neutral');
  assert.deepEqual(colourFor(null), { bg: '#141518', ink: DIM }, 'unknown language stays dimmed');
});

test('colourFor: a malformed override falls back rather than emitting fill="undefined"', () => {
  const fallback = colourFor('EN');
  for (const bad of [null, undefined, '', 'red', '#12', '#1234567', '#12345', 42, {}, ['#fff']]) {
    assert.deepEqual(colourFor('EN', { EN: bad }), fallback, `override ${JSON.stringify(bad)} rejected`);
  }
});

test('colourFor: a garbage override CONTAINER does not throw', () => {
  for (const bad of [null, undefined, 'nope', 42, ['#fff'], true]) {
    assert.deepEqual(colourFor('EN', bad), { bg: '#1e3a5f', ink: INK });
  }
  assert.deepEqual(colourFor(null, { EN: '#7a5cff' }), { bg: '#141518', ink: DIM });
});

test('colourFor: shorthand and unprefixed hex are accepted and normalized', () => {
  assert.equal(colourFor('EN', { EN: '#FFF' }).bg, '#ffffff');
  assert.equal(colourFor('EN', { EN: 'AABBCC' }).bg, '#aabbcc');
  assert.equal(colourFor('EN', { EN: '  #Ff0000  ' }).bg, '#ff0000');
});

test('colourFor: ink contrast flips with the chosen background', () => {
  assert.equal(colourFor('EN', { EN: '#ffffff' }).ink, INK_DARK, 'white bg -> dark ink');
  assert.equal(colourFor('EN', { EN: '#ffe08a' }).ink, INK_DARK, 'pale yellow -> dark ink');
  assert.equal(colourFor('EN', { EN: '#000000' }).ink, INK, 'black bg -> light ink');
  assert.equal(colourFor('EN', { EN: '#123456' }).ink, INK, 'deep blue -> light ink');
  assert.notEqual(INK, INK_DARK);
});

test('inkFor: the chosen ink always has the better contrast ratio of the two', () => {
  const lum = (hex) => {
    const ch = (i) => {
      const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
  };
  const ratio = (a, b) => {
    const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  // Sweep the grey ramp: whatever inkFor returns must be the better of the two everywhere.
  for (let v = 0; v <= 255; v += 15) {
    const bg = '#' + v.toString(16).padStart(2, '0').repeat(3);
    const picked = inkFor(bg);
    const other = picked === INK ? INK_DARK : INK;
    assert.ok(ratio(bg, picked) >= ratio(bg, other), `${bg}: picked ${picked} over ${other}`);
  }
  assert.ok(ratio('#ffffff', inkFor('#ffffff')) > 4.5, 'white bg gets a readable ink');
});

test('normalizeHex: rejects everything that is not a 3- or 6-digit hex colour', () => {
  assert.equal(normalizeHex('#AbCdEf'), '#abcdef');
  assert.equal(normalizeHex('#abcd'), null);
  assert.equal(normalizeHex('#ggg'), null);
  assert.equal(normalizeHex('rgb(1,2,3)'), null);
  assert.equal(normalizeHex(null), null);
  assert.equal(normalizeHex(0xffffff), null);
});

test('defaultBg: reports the swatch the PI should open on', () => {
  assert.equal(defaultBg('EN'), '#1e3a5f');
  assert.equal(defaultBg('RU'), '#d97757');
  assert.equal(defaultBg('DE'), '#141518');
  assert.equal(defaultBg(undefined), '#141518');
});
