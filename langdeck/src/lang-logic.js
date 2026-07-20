// plugin/src/lang-logic.js — pure language logic for the language-cycle key (#27).
// No I/O, no SDK, no claude-deck imports: this module and render-lang.js are deliberately
// self-contained so the action could be extracted into a standalone plugin (no prior art
// exists for it — see issue #27).
//
// HKLs are handled as UPPERCASE 8-char hex STRINGS end-to-end, matching what the PowerShell
// co-process emits ('{0:X8}' -f hkl). Strings avoid any signed-32-bit surprises and make
// equality checks trivial.

// Windows primary language IDs (langid & 0x3FF). Sublanguages collapse, so en-US, en-GB and
// a Dvorak en variant all read "EN" — which is what a person glancing at the key wants.
const PRIMARY = {
  0x01: 'AR', 0x02: 'BG', 0x04: 'ZH', 0x05: 'CS', 0x06: 'DA', 0x07: 'DE', 0x08: 'EL',
  0x09: 'EN', 0x0a: 'ES', 0x0b: 'FI', 0x0c: 'FR', 0x0d: 'HE', 0x0e: 'HU', 0x10: 'IT',
  0x11: 'JA', 0x12: 'KO', 0x13: 'NL', 0x14: 'NO', 0x15: 'PL', 0x16: 'PT', 0x19: 'RU',
  0x1d: 'SV', 0x1f: 'TR', 0x22: 'UK', 0x24: 'SL', 0x25: 'ET', 0x26: 'LV', 0x27: 'LT',
};

// Locked colours (#27): EN slate, RU clay. Both come from the existing render-lcd.js palette
// (render-lcd.js:16) — no new brand colours invented.
export const INK = '#eaf1f8';
export const DIM = '#8794a4';
export const WARN = '#e6864a';
const PINNED = { EN: '#1e3a5f', RU: '#d97757' };
// Any other language falls back to the plugin's existing neutral key background. Locked
// decision #6 is "no new colours invented", so this is build.mjs:25's `#141518` verbatim,
// NOT a generated ramp. A third language is out of scope (#27), so it gets the neutral face
// rather than speculative per-language colours.
const NEUTRAL = '#141518';   // build.mjs:25

export function normalizeHkl(hkl) {
  if (typeof hkl !== 'string') return null;
  const clean = hkl.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(clean)) return null;
  return clean.toUpperCase().padStart(8, '0');
}

export function primaryLangId(hkl) {
  const n = normalizeHkl(hkl);
  if (!n) return null;
  return parseInt(n.slice(-4), 16) & 0x3ff;   // low word = langid; low 10 bits = primary
}

export function labelFor(hkl) {
  const p = primaryLangId(hkl);
  if (p === null) return null;
  return PRIMARY[p] ?? p.toString(16).toUpperCase().padStart(2, '0');
}

// Ink used when a chosen background is too LIGHT for INK to read against. Deliberately the
// existing neutral key colour (build.mjs:25) rather than a fresh near-black — locked decision
// #6 ("no new colours invented") still applies to colours the plugin picks for itself; the
// user's own background is the only new colour in the system.
export const INK_DARK = NEUTRAL;

// '#abc' | '#aabbcc' -> '#aabbcc' (lowercase). Anything else -> null. The override map comes
// from action settings, i.e. from disk and from the property inspector, so it is untrusted:
// every consumer below treats a non-string / malformed / missing entry as "not configured"
// and falls back, rather than rendering `fill="undefined"` into the SVG.
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h}`;
}

// WCAG relative luminance of an '#rrggbb' string.
function luminance(hex) {
  const h = normalizeHex(hex);
  if (!h) return 0;
  const chan = (i) => {
    const c = parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
}

const contrast = (a, b) => {
  const [hi, lo] = luminance(a) >= luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
};

// Picks whichever of the two existing inks reads better on `bg` — one decision per language
// in the PI (#36), no second picker. Contrast RATIO rather than a luminance threshold: the
// two inks are not symmetric around mid-grey, so a fixed 0.5 cutoff picks wrong on mid tones.
export function inkFor(bg) {
  return contrast(bg, INK) >= contrast(bg, INK_DARK) ? INK : INK_DARK;
}

// PURE: `overrides` is passed in (from action settings) — this never reads settings itself,
// because it is the unit-tested core and plugin.js is the only place allowed to do I/O (#36).
// Automatic ink applies ONLY to user-chosen backgrounds. The pinned EN/RU faces keep INK
// verbatim so an unconfigured key looks EXACTLY as it did before this feature existed —
// inkFor('#d97757') actually prefers the dark ink, so deriving it here would silently
// restyle every existing RU key.
export function colourFor(label, overrides) {
  if (!label) return { bg: NEUTRAL, ink: DIM };
  const custom = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    ? normalizeHex(overrides[label])
    : null;
  if (custom) return { bg: custom, ink: inkFor(custom) };
  return { bg: PINNED[label] ?? NEUTRAL, ink: INK };
}

// The defaults the PI shows as each language's starting swatch, so an unconfigured key's
// picker opens on the colour actually on the key rather than on black.
export function defaultBg(label) {
  return PINNED[label] ?? NEUTRAL;
}

// Derives the key face from co-process state. Lives HERE, not in plugin.js, because it is the
// honesty-critical predicate (it decides whether the key may claim to know the language) and
// plugin.js is thin glue that runs main() on import, making it untestable.
// state: 'ok' | 'unknown' | 'starting' | 'single' | 'warn'
export function langFace(s, warnUntil = 0, now = Date.now()) {
  if (!s || !s.alive) return { label: null, state: 'starting' };
  if (!s.hkl) return { label: null, state: 'unknown' };
  const label = labelFor(s.hkl);
  if (warnUntil && now < warnUntil) return { label, state: 'warn' };
  if (!s.list || s.list.length < 2) return { label, state: 'single' };
  return { label, state: 'ok' };
}

// GetKeyboardLayoutList order is NOT contractually stable and was observed to DISAGREE with
// HKCU\Keyboard Layout\Preload on the dev machine (list: RU,EN — preload: EN,RU). Preload is
// the order Windows' own Alt+Shift walks, so the key cycles the same direction as the
// keyboard. Preload entries are layout IDs ('00000409'); match them on the low word.
export function orderLayouts(list, preload) {
  const items = (list || []).map(normalizeHkl).filter(Boolean);
  const numeric = [...items].sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
  if (!preload || !preload.length) return numeric;
  const rank = new Map();
  preload.map(normalizeHkl).filter(Boolean).forEach((p, i) => {
    if (!rank.has(p.slice(-4))) rank.set(p.slice(-4), i);
  });
  const known = [], unknown = [];
  for (const h of numeric) (rank.has(h.slice(-4)) ? known : unknown).push(h);
  known.sort((a, b) => rank.get(a.slice(-4)) - rank.get(b.slice(-4)));
  return [...known, ...unknown];
}

// Wraps at the end. A current HKL that is not in the list (transiently possible right after a
// layout is added or removed) yields list[0] instead of throwing.
export function nextLayout(current, ordered) {
  if (!ordered || !ordered.length) return null;
  const cur = normalizeHkl(current);
  const i = cur ? ordered.indexOf(cur) : -1;
  return ordered[(i + 1) % ordered.length];
}

// Wire format from the co-process: "<currentHkl>|<hkl,hkl,...>|<hwnd>"
export function parseStateLine(line) {
  if (typeof line !== 'string') return null;
  const parts = line.trim().split('|');
  if (parts.length !== 3) return null;
  const [rawHkl, rawList, hwnd] = parts;
  const list = rawList.split(',').map(normalizeHkl).filter(Boolean);
  // hwnd 0 == no foreground window: the layout read is meaningless, so report it as unknown.
  const hkl = hwnd === '0' ? null : normalizeHkl(rawHkl);
  return { hkl, list, hwnd };
}
