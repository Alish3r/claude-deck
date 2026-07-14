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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const SETTINGS_KEY = 'effortLevel';
// Dial ladder, low -> high. 'auto' = unset; 'max' = xhigh + ultracode (webview).
export const EFFORT_LADDER = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

export function defaultSettingsPath() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('cannot resolve home dir (USERPROFILE/HOME unset)');
  return join(home, '.claude', 'settings.json');
}

// Map a dial position to what actually gets applied. `settingsLevel === undefined`
// means "remove the key" (Auto). `ultracode` is the webview intent for 'max' — this
// module owns only the settings half and returns the ultracode flag for the caller
// (hub) to route to the webview bridge.
export function resolveEffort(level) {
  switch (level) {
    case 'auto': return { settingsLevel: undefined, ultracode: false };
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh': return { settingsLevel: level, ultracode: false };
    case 'max': return { settingsLevel: 'xhigh', ultracode: true };
    default: throw new Error(`unknown effort level: ${level} (want one of ${EFFORT_LADDER.join('|')})`);
  }
}

const io = { readFile: readFileSync, writeFile: writeFileSync, exists: existsSync };

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
  if (present && typeof obj[SETTINGS_KEY] === 'string') {
    const re = new RegExp(`("${SETTINGS_KEY}"\\s*:\\s*)"[^"]*"`);
    if (re.test(raw)) return raw.replace(re, `$1"${settingsLevel}"`);
  }
  return serialize({ ...obj, [SETTINGS_KEY]: settingsLevel }, raw);
}

// Closed-loop effort write: back up once, write, READ BACK, retry on mismatch, throw if
// it never persists. Preserves all other keys. Returns { level, settingsLevel, ultracode,
// attempts, changed }.
export function setEffort(path, level, {
  retries = 3, backup = true,
  readFile = io.readFile, writeFile = io.writeFile, exists = io.exists,
} = {}) {
  if (!path) throw new Error('setEffort requires a settings path');
  const { settingsLevel, ultracode } = resolveEffort(level);

  if (backup && exists(path)) {
    const bak = path + '.cdbak-settings';
    if (!exists(bak)) writeFile(bak, readFile(path, 'utf8'));
  }

  let lastSeen;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const raw = exists(path) ? readFile(path, 'utf8') : '{}\n';
    const obj = JSON.parse(raw);
    const next = applyEffort(raw, obj, settingsLevel);
    const changed = next !== raw;
    writeFile(path, next);

    const after = JSON.parse(readFile(path, 'utf8')); // <-- the crucial read-back
    lastSeen = SETTINGS_KEY in after ? after[SETTINGS_KEY] : undefined;
    const ok = settingsLevel === undefined ? !(SETTINGS_KEY in after) : lastSeen === settingsLevel;
    if (ok) return { level, settingsLevel: settingsLevel ?? null, ultracode, attempts: attempt, changed };
  }
  throw new Error(`effort '${level}' did not persist after ${retries} attempts (last seen: ${JSON.stringify(lastSeen)})`);
}
