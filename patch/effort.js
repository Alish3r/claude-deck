// Dial 2 = effort, as a ⊙GLOBAL control (M1 gate #3).
//
// Effort is global: it lives in ~/.claude/settings.json under `effortLevel`, shared by
// every chat, every window, and the CLI default. Two hard-won facts from the M1 spike
// (see docs/BRIDGE-PROTOCOL.md) shape this module:
//   1. `setEffortLevel` (the webview method) can return ok:true yet NOT persist — so we
//      never drive effort through the webview; we write settings.json and READ IT BACK.
//   2. The webview `effortLevel` signal tracks neither settings edits nor its own method,
//      so settings.json is the sole source of truth for effective effort.
//
// All fs access is injectable so the closed-loop retry/guard is unit-testable without
// touching the real settings.json.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { EFFORT_LADDER } from './effort-ladder.js';

export const SETTINGS_KEY = 'effortLevel';
export { EFFORT_LADDER };

export function defaultSettingsPath() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('cannot resolve home dir (USERPROFILE/HOME unset)');
  return join(home, '.claude', 'settings.json');
}

// Map a dial position to what actually gets applied. `settingsLevel === undefined`
// means "remove the key" (Auto). `ultracode` (the top ladder position) resolves to
// xhigh + the ultracode flag — this module owns only the settings half and returns the
// ultracode flag for the caller (hub) to route to the webview bridge.
export function resolveEffort(level) {
  switch (level) {
    case 'auto': return { settingsLevel: undefined, ultracode: false };
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max': return { settingsLevel: level, ultracode: false };
    case 'ultracode': return { settingsLevel: 'xhigh', ultracode: true };
    default: throw new Error(`unknown effort level: ${level} (want one of ${EFFORT_LADDER.join('|')})`);
  }
}

const io = { readFile: readFileSync, writeFile: writeFileSync, exists: existsSync, rename: renameSync };

// Current effort as a dial position: 'auto' when unset, else the stored value.
export function readEffort(path = defaultSettingsPath(), { readFile = io.readFile, exists = io.exists } = {}) {
  if (!exists(path)) return 'auto';
  try {
    const obj = JSON.parse(readFile(path, 'utf8'));
    return SETTINGS_KEY in obj ? obj[SETTINGS_KEY] : 'auto';
  } catch {
    return 'auto';
  }
}

function indentOf(raw) {
  const m = /\n(\s+)"/.exec(raw);
  return m ? m[1].length : 2;
}

function serialize(obj, raw) {
  return JSON.stringify(obj, null, indentOf(raw)) + (raw.endsWith('\n') ? '\n' : '');
}

// Produce the next settings text. Targeted value-edit when the key is already present
// (preserves the user's formatting); reserialize only for insert/delete.
function applyEffort(raw, obj, settingsLevel) {
  const present = SETTINGS_KEY in obj;
  if (settingsLevel === undefined) {
    if (!present) return raw; // already Auto — no-op
    const rest = { ...obj };
    delete rest[SETTINGS_KEY];
    return serialize(rest, raw);
  }
  // Targeted edit only for plain unescaped string values — a value containing a
  // backslash-escape would let the naive quote-bounded regex cut the JSON mid-string
  // and CORRUPT the user's global settings file.
  if (present && typeof obj[SETTINGS_KEY] === 'string' && !/[\\"]/.test(obj[SETTINGS_KEY])) {
    const re = new RegExp(`("${SETTINGS_KEY}"\\s*:\\s*)"[^"\\\\]*"`);
    if (re.test(raw)) {
      const next = raw.replace(re, `$1"${settingsLevel}"`);
      // The regex replaces the FIRST textual "effortLevel" — if a nested object carries a
      // same-named key that appears earlier in the file, the targeted edit would hit the
      // wrong one and leave the authoritative top-level key unchanged. Confirm the edit
      // actually landed on the top-level key before trusting it; else reserialize.
      try { const parsed = JSON.parse(next); if (parsed[SETTINGS_KEY] === settingsLevel) return next; } catch { /* fall through to reserialize */ }
    }
  }
  return serialize({ ...obj, [SETTINGS_KEY]: settingsLevel }, raw);
}

// Closed-loop effort write: back up once, write, READ BACK, retry on mismatch, throw if
// it never persists. Preserves all other keys. Returns { level, settingsLevel, ultracode,
// attempts, changed }.
export function setEffort(path, level, {
  retries = 3, backup = true,
  readFile = io.readFile, writeFile = io.writeFile, exists = io.exists, rename = io.rename,
} = {}) {
  if (!path) throw new Error('setEffort requires a settings path');
  const { settingsLevel, ultracode } = resolveEffort(level);

  // ATOMIC writes only: this is the user's global Claude settings — a kill mid-
  // writeFileSync (truncate-then-write) would leave it corrupt. tmp+rename swaps whole.
  const atomicWrite = (p, data) => { writeFile(p + '.cdtmp', data); rename(p + '.cdtmp', p); };

  if (backup && exists(path)) {
    const bak = path + '.cdbak-settings';
    // best-effort convenience snapshot (never auto-restored) — a backup failure must not
    // abort the closed-loop write, which is read-back-verified on its own
    if (!exists(bak)) { try { atomicWrite(bak, readFile(path, 'utf8')); } catch { /* skip */ } }
  }

  let lastSeen;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const raw = exists(path) ? readFile(path, 'utf8') : '{}\n';
    const obj = JSON.parse(raw);
    const next = applyEffort(raw, obj, settingsLevel);
    const changed = next !== raw;
    // A failed write is not fatal — the read-back below detects it and the loop retries.
    try { atomicWrite(path, next); } catch { /* verified below */ }

    let after;
    try { after = JSON.parse(readFile(path, 'utf8')); } catch { continue; } // <-- the crucial read-back
    lastSeen = SETTINGS_KEY in after ? after[SETTINGS_KEY] : undefined;
    const ok = settingsLevel === undefined ? !(SETTINGS_KEY in after) : lastSeen === settingsLevel;
    if (ok) return { level, settingsLevel: settingsLevel ?? null, ultracode, attempts: attempt, changed };
  }
  throw new Error(`effort '${level}' did not persist after ${retries} attempts (last seen: ${JSON.stringify(lastSeen)})`);
}
