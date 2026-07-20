// plugin/src/render-lang.js — 72x72 Stream Deck key face for the language-cycle action (#27).
// Pure SVG string generation, exactly like render-lcd.js: plugin.js rasterizes with sharp, so
// these tests need no rasterizer. No claude-deck imports (see lang-logic.js header).

import { colourFor, WARN } from './lang-logic.js';

const W = 72, H = 72;

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// state: 'ok' | 'unknown' | 'starting' | 'single' | 'warn'
// `colours` is the per-key override map from action settings ({ EN: '#123456', … }), threaded
// through as DATA — this module still knows nothing about settings or the SDK.
export function renderLangSvg({ label, state = 'ok', colours = null }) {
  const placeholder = state === 'starting' ? '…' : '—';
  const raw = label ? String(label) : placeholder;
  const text = esc(raw);
  const known = Boolean(label);

  // colourFor(null) already returns the neutral background + dim ink, so there is no second
  // literal here — an inline fallback is how the invented '#1b1d22' slipped past the
  // "no new colours invented" locked decision the first time.
  const { bg, ink: fg } = colourFor(known ? label : null, colours);
  // Measure the RAW label, not the escaped one: esc('A&B') is 7 chars and would wrongly
  // trigger the small face. A 2-char code is the common case; longer unmapped hex codes
  // (labelFor's fallback maxes at 3 chars) drop a size.
  const size = raw.length > 3 ? 24 : 34;
  const opacity = state === 'single' ? '0.45' : '1';

  const warnDot = state === 'warn'
    ? `<circle id="warn" cx="60" cy="12" r="5" fill="${WARN}"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" rx="14" fill="${bg}"/>`
    + `<g opacity="${opacity}">`
    + `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" dominant-baseline="central" `
    + `font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="600" `
    + `font-size="${size}" fill="${fg}">${text}</text>`
    + `</g>${warnDot}</svg>`;
}
