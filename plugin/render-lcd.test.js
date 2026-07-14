// LCD pixmap renderer tests — pure SVG string generation, no sharp/rasterization needed.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderModelSvg, renderEffortSvg, resolvedShort } from './src/render-lcd.js';

test('model header: full chat name at 11px; long names scroll by PIXELS inside a clip window', () => {
  const long = 'auth-token-refresh-refactor-for-the-whole-service';
  const s0 = renderModelSvg(OK_TS({ summary: long }), { marqueeOffset: 0 }, long);
  assert.match(s0, /font-size="11"/, 'header enlarged ~25%');
  assert.match(s0, /clipPath/, 'overflowing name renders in a clipped scroll window');
  assert.match(s0, new RegExp(`${long}.+${long}`), 'text doubled for seamless wraparound');
  const s5 = renderModelSvg(OK_TS({ summary: long }), { marqueeOffset: 5 }, long);
  assert.match(s5, /<text x="-1"/, 'pixel offset shifts the text (4 - 5 = -1), not character jumps');
  // short names render whole, centered, no clip machinery
  const short = renderModelSvg(OK_TS(), { marqueeOffset: 7 }, 'tiny-chat');
  assert.match(short, /tiny-chat/);
  assert.doesNotMatch(short, /clipPath/);
});

const OK_TS = (extra) => ({ kind: 'ok', windowId: 'A', sessionId: 's1', model: 'claude-fable-5', effort: 'high', catalog: [], ...extra });

test('resolvedShort: dotted versions, [1m] and date snapshots stripped', () => {
  assert.equal(resolvedShort('claude-opus-4-8[1m]'), 'Opus 4.8');
  assert.equal(resolvedShort('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(resolvedShort('claude-fable-5'), 'Fable 5');
  assert.equal(resolvedShort(null), '');
});

test('renderModelSvg: model names carry their version, 25px, with a per-family context line', () => {
  const ts = OK_TS({
    model: 'haiku', modelResolved: 'claude-haiku-4-5-20251001',
    catalog: [{ value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001' }],
  });
  const svg = renderModelSvg(ts, {}, 'code▸auth');
  assert.match(svg, />Haiku 4\.5</, 'versioned name, not the bare displayName');
  assert.match(svg, /font-size="25"/, 'main label enlarged ~20%');
  assert.match(svg, /Fast - Chats, Summaries, Translations/, 'haiku context line');
  assert.match(svg, /textLength="188"/, 'long context lines squeeze-to-fit instead of overflowing');

  const fable = renderModelSvg(OK_TS({ model: 'claude-fable-5[1m]', modelResolved: 'claude-fable-5' }));
  assert.match(fable, />Fable 5</);
  const sonnet = renderModelSvg(OK_TS({ model: 'sonnet', modelResolved: 'claude-sonnet-5', catalog: [{ value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5' }] }));
  assert.match(sonnet, />Sonnet 5</);
});

test('renderModelSvg: default row renders big Default + resolved model in small type', () => {
  const ts = OK_TS({
    model: 'default', modelResolved: 'claude-opus-4-8[1m]',
    catalog: [{ value: 'default', label: 'Default (recommended)', resolved: 'claude-opus-4-8[1m]' }],
  });
  const svg = renderModelSvg(ts, {}, 'code▸auth');
  assert.match(svg, />Default</, 'big label is just "Default"');
  assert.match(svg, />Opus 4\.8 · recommended</, 'resolved model + recommended beneath');
  assert.doesNotMatch(svg, /\(recommended\)/, 'the overflowing displayName is never rendered');
  // browsing over the default catalog row shows the same treatment
  const browsing = renderModelSvg(ts, { phase: 'browsing', browseValue: 'default', browseLabel: 'Default (recommended)' });
  assert.match(browsing, />Default</);
  assert.match(browsing, />Opus 4\.8 · recommended</);
});

test('renderModelSvg: valid SVG, shows the model label + atmosphere + chat half', () => {
  const svg = renderModelSvg(OK_TS(), {}, 'code▸auth');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="200" height="100"/);
  assert.match(svg, /Fable 5/);
  assert.match(svg, /code▸auth/);
  assert.match(svg, /radialGradient/); // atmosphere present
});

test('renderModelSvg: sentinel states render a status message, not a model value', () => {
  const svg = renderModelSvg({ kind: 'no-vscode' });
  assert.match(svg, /No VS Code/);
  assert.doesNotMatch(svg, /Fable/);
});

test('renderModelSvg: browsing shows the browse value; applying/confirmed/error swap the glyph', () => {
  // no catalog resolution while browsing -> the versioned short name derives from the slug
  assert.match(renderModelSvg(OK_TS(), { phase: 'browsing', browseValue: 'claude-opus-4-8' }), /Opus 4\.8/);
  const applying = renderModelSvg(OK_TS(), { phase: 'applying' });
  assert.match(applying, /animateTransform/, 'spinner glyph animates');
});

test('renderModelSvg: a busy chat keeps its model + spin-driven spinner chip (busy ≠ compacting)', () => {
  const busy = OK_TS({ busy: true });
  const s0 = renderModelSvg(busy, { spin: 0 }, 'code▸auth');
  assert.doesNotMatch(s0, /COMPACTING/, 'generic busy is not the compacting screen');
  assert.match(s0, /Fable 5/, 'model stays visible while busy');
  assert.match(s0, /rotate\(0\)/);
  assert.match(renderModelSvg(busy, { spin: 3 }), /rotate\(45\)/, 'spin advances the (slowed) spinner chip');
  assert.match(s0, /opacity="\.5"/, 'busy cue is subtle, not an interaction glyph');
});

test('renderModelSvg: compacting screen only for the explicit compact phase, rotor spins', () => {
  const s0 = renderModelSvg(OK_TS(), { phase: 'compacting', spin: 0 }, 'code▸auth');
  assert.match(s0, /COMPACTING/);
  assert.match(s0, /rotate\(0\)/);
  assert.match(renderModelSvg(OK_TS(), { phase: 'compacting', spin: 3 }), /rotate\(90\)/, 'spin advances the rotor angle');
});

test('renderModelSvg: an active interaction is never masked by busy', () => {
  const busy = OK_TS({ busy: true });
  assert.doesNotMatch(renderModelSvg(busy, { phase: 'browsing', browseValue: 'claude-opus-4-8' }), /COMPACTING/);
  assert.doesNotMatch(renderModelSvg(busy, { phase: 'applying' }), /COMPACTING/);
});

test('renderEffortSvg: no header text, 22px level + 6 staircase bars', () => {
  const svg = renderEffortSvg(OK_TS());
  assert.doesNotMatch(svg, /GLOBAL/, 'top text removed');
  assert.match(svg, /font-size="28"[^>]*>high</, 'level text large enough to read at a glance');
  // the current (cur) bar renders an extra stroke-outline rect — exclude fill="none" so
  // only the six actual bars are counted, not the highlight overlay
  const bars = svg.match(/<rect x="[\d.]+" y="[\d.]+" width="16" height="[\d.]+" rx="2\.5" fill="(?!none)/g) || [];
  assert.equal(bars.length, 6, 'six ladder bars rendered');
});

test('renderEffortSvg: ultracode (top) shows all bars lit and the label', () => {
  const svg = renderEffortSvg(OK_TS({ effort: 'ultracode' }));
  assert.match(svg, />ultracode</);
});

test('renderEffortSvg: browsing uses the browse value for level + bar count', () => {
  const svg = renderEffortSvg(OK_TS(), { phase: 'browsing', browseValue: 'auto' });
  assert.match(svg, />Auto</); // effortLabel capitalizes 'auto'
});

test('renderEffortSvg: flash adds a colour veil', () => {
  const plain = renderEffortSvg(OK_TS());
  const flashed = renderEffortSvg(OK_TS(), { flash: true });
  assert.doesNotMatch(plain, /flashg/);
  assert.match(flashed, /flashg/);
});
