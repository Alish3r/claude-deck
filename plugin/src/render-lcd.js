// Composited 200x100 LCD renderer — pure SVG string generation (testable without a
// rasterizer). plugin.js turns the SVG into a PNG data URI (sharp) and pushes it as a
// single full-canvas `pixmap` layout item (layouts/dial.json). Ports the mockup's visual
// language onto real Elgato hardware: per-model atmosphere, the eq-staircase effort meter
// (design-panel winner), and the chat name split across both dial canvases.
//
// Each dial has its OWN independent 200x100 canvas (they are separate action instances) —
// there is no way to draw literally across the physical gap between them. splitChatName
// approximates continuity: the model canvas gets the first half right-aligned, the effort
// canvas gets the second half left-aligned, so adjacent dials read as one continuous label.

import { EFFORT_LADDER } from '../../patch/effort-ladder.js';
import { modelShort, effortLabel } from './lcd.js';

const W = 200, H = 100;
const INK = '#eaf1f8', DIM = '#8794a4', CLAY = '#d97757', CLAY_HI = '#f0916f';
const OK = '#5bd6a0', WARN = '#e6864a';
const ERAMP = ['#4fd6be', '#5fd0a8', '#e6b450', '#e0965c', '#d97757', '#ff3d2e']; // per ladder step, teal->hot

// Per-model atmosphere (radial gradient stops) + a tiny emblem glyph. Unknown model -> neutral.
const ATMO = {
  'claude-opus-4-8': { a: '#3a2a5a', b: '#140f22', glyph: 'brain' },
  'claude-sonnet-5': { a: '#1e3a5f', b: '#0b1622', glyph: 'spark' },
  'claude-haiku-4-5': { a: '#164039', b: '#0a1a18', glyph: 'zap' },
  'claude-fable-5': { a: '#4a2f1e', b: '#1d1109', glyph: 'spark' },
};
const atmoFor = (v) => ATMO[v] || { a: '#20232a', b: '#0c0e11', glyph: 'spark' };

const EMBLEM = {
  brain: `<path d="M0-16a9 9 0 0 0-18 1.5C-21 -12.5 -22 -10 -22 -7c0 4.5 3 6 3 6s-3 3-3 7.5S-19 14-16 15.5A9 9 0 0 0 0 24M0-16a9 9 0 0 1 18 1.5C21-12.5 22-10 22-7c0 4.5-3 6-3 6s3 3 3 7.5S19 14 16 15.5A9 9 0 0 1 0 24V-16z" fill="none" stroke="#fff" stroke-width="1.4" opacity=".16"/>`,
  spark: `<path d="M0-24 5.7 -7.3 22 0 5.7 7.3 0 24 -5.7 7.3 -22 0 -5.7 -7.3Z" fill="#fff" opacity=".14"/>`,
  zap: `<path d="M6-24-18 4h14l-3 20 25-27H4Z" fill="#fff" opacity=".14"/>`,
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Human-short name from a concrete model slug: 'claude-opus-4-8[1m]' -> 'Opus 4.8',
// 'claude-haiku-4-5-20251001' -> 'Haiku 4.5' (date snapshots dropped, version dotted).
export function resolvedShort(slug) {
  if (!slug) return '';
  const t = String(slug).replace(/^claude-/, '').replace(/\[.*?\]$/, '').split('-');
  const nums = t.slice(1).filter((x) => /^\d+$/.test(x) && x.length < 8);
  const family = (t[0] || '').replace(/^\w/, (c) => c.toUpperCase());
  return `${family}${nums.length ? ' ' + nums.slice(0, 2).join('.') : ''}`.trim();
}

// One-line context per model family, small type under the name. Haiku's wording is the
// user-specified fit-safe form; long lines additionally squeeze via SVG textLength.
const CONTEXT = {
  haiku: 'Fast - Chats, Summaries, Translations',
  sonnet: 'Balanced - Everyday coding & writing',
  opus: 'Deep reasoning - Hard problems',
  fable: 'Most capable - Complex, long work',
};
const familyOf = (slug) => String(slug || '').replace(/^claude-/, '').replace(/\[.*?\]$/, '').split('-')[0];

// Centered small text that can never overflow: past ~33 chars at 9.5px it compresses
// glyph spacing to the 188px content width instead of clipping at the canvas edge.
function fitText(y, text, fill = DIM, fs = 9.5) {
  if (!text) return '';
  const squeeze = text.length * fs * 0.6 > 188 ? ` textLength="188" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="monospace" font-size="${fs}" font-weight="600" fill="${fill}"${squeeze}>${esc(text)}</text>`;
}

// Chat-name header: the model canvas shows the FULL name at 11px across the full width
// (the effort canvas no longer carries a header at all). Longer than the window -> a
// PIXEL-scrolled marquee: the text is doubled (seamless wraparound) inside a clip window
// and translated by ui.marqueeOffset pixels, advanced ~2px/frame by the action's tick
// clock — character-step slicing scrolled in visible 6.6px jumps.
export const HEADER_CHARS = 28;
const HEADER_FS = 11, HEADER_CW = HEADER_FS * 0.6; // monospace advance ≈ 0.6em

function headerLine(text, offPx) {
  if (text.length <= HEADER_CHARS) {
    return `<text x="${W / 2}" y="12" text-anchor="middle" font-family="monospace" font-size="${HEADER_FS}" font-weight="600" fill="${DIM}">${esc(text)}</text>`;
  }
  const gap = '   •   ';
  const cycle = (text.length + gap.length) * HEADER_CW;
  const off = ((offPx || 0) % cycle + cycle) % cycle;
  return `<clipPath id="hdr"><rect x="4" y="0" width="${W - 8}" height="18"/></clipPath>`
    + `<g clip-path="url(#hdr)"><text x="${+(4 - off).toFixed(1)}" y="12" font-family="monospace" font-size="${HEADER_FS}" font-weight="600" fill="${DIM}">${esc(text + gap + text)}</text></g>`;
}

// spinDeg: static rotation for the spinner glyph — a rasterized PNG can't run SMIL, so
// the caller advances ui.spin frame-by-frame and we bake the angle in (like the rotor).
// subtle: the passive busy cue — smaller and dimmer than interaction glyphs, so a working
// chat registers at a glance without competing with the model label.
function chip(cx, cy, glyph, color, spinDeg = null, subtle = false) {
  if (!glyph) return '';
  const paths = { ok: `M-6 0 -2 4 6-5`, warn: `M0-6 6 5-6 5Z M0-1V-3.5 M0 2.2h.01`, spinner: `M6 0A6 6 0 1 1 -4.2-4.2` };
  const p = paths[glyph]; if (!p) return '';
  const baked = glyph === 'spinner' && spinDeg != null;
  const rot = glyph === 'spinner' && !baked ? `<animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="0.9s" repeatCount="indefinite"/>` : '';
  const tone = subtle ? ' opacity=".5"' : '';
  const size = subtle ? ' scale(0.72)' : '';
  return `<g transform="translate(${cx},${cy})${baked ? ` rotate(${spinDeg})` : ''}${size}"${tone} stroke="${color}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">${rot}<path d="${p}"/></g>`;
}

function frame(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
}

const titleText = (label) => `<text x="${W / 2}" y="12" text-anchor="middle" font-family="monospace" font-size="10" font-weight="600" fill="${DIM}" letter-spacing=".3">${esc(label)}</text>`;

// dial:'model'|'effort'. targetState: lcd.js sentinel/ok shape. ui:{phase,browseValue,flash}.
// chatHalf: the FULL chat label (header is model-canvas-only; marquee when overflowing).
export function renderModelSvg(targetState, ui = {}, chatHalf = '') {
  if (targetState.kind !== 'ok') return frame(sentinel(targetState, 'MODEL'));
  // browsing/applying/confirmed all show the user's pick (never flash back mid-apply)
  const showPick = ui.browseValue != null && ['browsing', 'applying', 'confirmed'].includes(ui.phase);
  const value = showPick ? ui.browseValue : targetState.model;
  // 'default' (and aliases) hide the real model — surface it: big "Default", the concrete
  // resolved model in small type beneath. Resolution: the catalog row's resolved slug
  // (browse can preview any row), else the chat's own modelResolved.
  const catRow = (targetState.catalog || []).find((m) => m && m.value === value);
  const resolved = (catRow && catRow.resolved) || (!showPick && targetState.modelResolved) || null;
  const isDefault = value === 'default';
  const atmo = atmoFor(String(resolved || value || '').replace(/\[.*?\]$/, ''));
  // Compacting screen: ONLY the dial's own compact command (the optimistic press paints
  // phase:'compacting'). The chat's busy signal is generic — any generation raises it —
  // so a busy chat keeps its model visible with a spin-driven spinner chip instead;
  // busy ≠ compacting (#32). Browsing/applying/confirm/error still take priority over
  // the busy cue. Spinner/rotor motion comes from the caller advancing ui.spin
  // frame-by-frame (a rasterized PNG can't self-animate).
  if (ui.phase === 'compacting') {
    return frame(compactingBlock(atmo, chatHalf, ui.spin || 0));
  }
  const interacting = ['browsing', 'applying', 'confirmed', 'error'].includes(ui.phase);
  const busyIdle = !!targetState.busy && !interacting;
  // ui.browseLabel lets the caller (which knows the catalog) supply the real display
  // label while browsing; without it modelShort falls back to guessing from the slug.
  // Big line: the VERSIONED name ('Fable 5', 'Opus 4.8') derived from the resolved slug —
  // live displayNames are versionless. Default keeps 'Default' big + its resolved model
  // small. Every concrete model gets a per-family context line beneath.
  const label = isDefault ? 'Default'
    : (resolvedShort(resolved || value) || modelShort({ model: value, modelLabel: showPick ? (ui.browseLabel ?? null) : targetState.modelLabel }));
  const sub = isDefault && resolved ? `${resolvedShort(resolved)} · recommended` : '';
  const context = !isDefault ? (CONTEXT[familyOf(resolved || value)] || '') : '';
  const glyph = ui.phase === 'applying' ? 'spinner' : ui.phase === 'confirmed' ? 'ok' : ui.phase === 'error' ? 'warn' : busyIdle ? 'spinner' : null;
  const flash = ui.flash ? `<rect width="${W}" height="${H}" fill="#fff" opacity="0.22"/>` : '';
  return frame(`
    <defs><radialGradient id="atmo" cx="30%" cy="15%" r="85%">
      <stop offset="0%" stop-color="${atmo.a}"/><stop offset="100%" stop-color="${atmo.b}"/>
    </radialGradient></defs>
    <rect width="${W}" height="${H}" fill="${atmo.b}"/>
    <rect width="${W}" height="${H}" fill="url(#atmo)"/>
    <g transform="translate(${W - 22},${H - 14})">${EMBLEM[atmo.glyph] || ''}</g>
    ${chatHalf ? headerLine(chatHalf, ui.marqueeOffset ?? 0) : titleText('MODEL')}
    <text x="${W / 2}" y="${sub || context ? 50 : 56}" text-anchor="middle" font-family="monospace" font-size="25" font-weight="800" fill="${INK}">${esc(label)}</text>
    ${sub ? fitText(68, sub, DIM, 11) : ''}
    ${context ? fitText(68, context) : ''}
    ${chip(16, H - 12, glyph, glyph === 'warn' ? WARN : glyph === 'ok' ? OK : CLAY, busyIdle ? ((ui.spin || 0) % 24) * 15 : null, busyIdle)}
    ${flash}
  `);
}

// No header line: the level IS the message (⊙GLOBAL semantics live in the docs + sentinel).
export function renderEffortSvg(targetState, ui = {}) {
  if (targetState.kind !== 'ok') return frame(sentinel(targetState, '⊙ GLOBAL'));
  const showPick = ui.browseValue != null && ['browsing', 'applying', 'confirmed'].includes(ui.phase);
  const level = showPick ? ui.browseValue : (targetState.effort ?? 'auto');
  // 'auto' (absent settings key) isn't a rung: label says Auto, no bars lit, no dot
  const idx = EFFORT_LADDER.indexOf(level);
  const n = EFFORT_LADDER.length;
  const barW = 16, gap = 6, totalW = n * barW + (n - 1) * gap;
  const x0 = (W - totalW) / 2, baseY = H - 12;
  const bars = EFFORT_LADDER.map((_, i) => {
    const h = 8 + i * 4, x = x0 + i * (barW + gap), y = baseY - h;
    const on = i <= idx, c = ERAMP[i];
    const pop = ui.flash && i === idx ? ` transform="scale(1,1.12)" transform-origin="${x + barW / 2} ${baseY}"` : '';
    return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2.5" fill="${on ? c : '#232a33'}" opacity="${on ? 1 : 0.35}"${pop}/>`
      + (i === idx ? `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2.5" fill="none" stroke="#fff" stroke-opacity=".45"/>` : '');
  }).join('');
  const dotX = x0 + idx * (barW + gap) + barW / 2, dotY = baseY - (8 + idx * 4) - 3;
  const dot = idx < 0 ? '' : `<circle cx="${dotX}" cy="${dotY}" r="3" fill="#fff"><animate attributeName="opacity" values="1;0.6;1" dur="1.1s" repeatCount="indefinite"/></circle>`;
  const flashColor = ERAMP[idx] || ERAMP[0];
  const flashDefs = ui.flash
    ? `<defs><radialGradient id="flashg" cx="50%" cy="90%" r="70%"><stop offset="0%" stop-color="${flashColor}"/><stop offset="100%" stop-color="${flashColor}" stop-opacity="0"/></radialGradient></defs>`
    : '';
  const veil = ui.flash ? `<rect width="${W}" height="${H}" fill="url(#flashg)" opacity="0.6"/>` : '';
  return frame(`
    ${flashDefs}
    <rect width="${W}" height="${H}" fill="#080b10"/>
    <text x="${W / 2}" y="32" text-anchor="middle" font-family="monospace" font-size="28" font-weight="800" fill="${INK}">${esc(effortLabel(level))}</text>
    ${bars}
    ${dot}
    ${veil}
  `);
}

// Compacting screen for the model dial: the model's own atmosphere (so it still reads as
// "this dial"), a Claude-orange arc rotated by `spin` (the caller advances it each frame),
// and a pulsing label. `spin` is a frame counter; 12 frames = one revolution.
function compactingBlock(atmo, chatHalf, spin) {
  const deg = (spin % 12) * 30;
  return `
    <defs><radialGradient id="atmo" cx="30%" cy="15%" r="85%">
      <stop offset="0%" stop-color="${atmo.a}"/><stop offset="100%" stop-color="${atmo.b}"/>
    </radialGradient></defs>
    <rect width="${W}" height="${H}" fill="${atmo.b}"/>
    <rect width="${W}" height="${H}" fill="url(#atmo)"/>
    ${chatHalf ? headerLine(chatHalf, 0) : titleText('MODEL')}
    <g transform="translate(${W / 2},46) rotate(${deg})" stroke="${CLAY_HI}" stroke-width="3" fill="none" stroke-linecap="round">
      <path d="M15 0A15 15 0 1 1 -10.6 -10.6" opacity=".95"/>
    </g>
    <circle cx="${W / 2}" cy="46" r="15" fill="none" stroke="${CLAY}" stroke-width="3" opacity=".18"/>
    <text x="${W / 2}" y="86" text-anchor="middle" font-family="monospace" font-size="13" font-weight="800" fill="${INK}" letter-spacing=".5">COMPACTING</text>
  `;
}

function sentinel(ts, label) {
  const msg = { 'no-vscode': 'No VS Code', 'no-chat': 'No chat', 'not-started': 'Not started' }[ts.kind] || ts.kind;
  return `<rect width="${W}" height="${H}" fill="#0a0c10"/>${titleText(label)}
    <text x="${W / 2}" y="56" text-anchor="middle" font-family="monospace" font-size="14" font-weight="700" fill="${DIM}">${esc(msg)}</text>`;
}
