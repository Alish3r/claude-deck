// Generic closed-loop reader/writer for ~/.claude/settings.json keys (model, effortLevel).
// Same discipline as patch/effort.js (which stays as the effort-specific wrapper): targeted
// value-edit preserving formatting + other keys, backup once, read back and verify, retry.
// This is the basis of the UNIVERSAL mode — settings.json is the single cross-interface,
// cross-OS control point for the global default model + effort (no reverse-engineering).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function defaultSettingsPath() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('cannot resolve home dir (USERPROFILE/HOME unset)');
  return join(home, '.claude', 'settings.json');
}

const io = { readFile: readFileSync, writeFile: writeFileSync, exists: existsSync };

export function readKey(path, key, { readFile = io.readFile, exists = io.exists } = {}) {
  if (!exists(path)) return undefined;
  try {
    const obj = JSON.parse(readFile(path, 'utf8'));
    return key in obj ? obj[key] : undefined;
  } catch { return undefined; }
}

function indentOf(raw) { const m = /\n(\s+)"/.exec(raw); return m ? m[1].length : 2; }
function serialize(obj, raw) { return JSON.stringify(obj, null, indentOf(raw)) + (raw.endsWith('\n') ? '\n' : ''); }

// Produce next settings text. `value === undefined` removes the key. Targeted string-edit
// when the key already holds a string (preserves the user's formatting); reserialize only
// for insert/delete or a non-string value.
function apply(raw, obj, key, value) {
  const present = key in obj;
  if (value === undefined) {
    if (!present) return raw;
    const rest = { ...obj }; delete rest[key]; return serialize(rest, raw);
  }
  if (present && typeof obj[key] === 'string' && typeof value === 'string') {
    const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
    if (re.test(raw)) return raw.replace(re, `$1"${value}"`);
  }
  return serialize({ ...obj, [key]: value }, raw);
}

// Closed-loop write: back up once, write, READ BACK, retry, throw if it never persists.
export function setKey(path, key, value, {
  retries = 3, backup = true,
  readFile = io.readFile, writeFile = io.writeFile, exists = io.exists,
} = {}) {
  if (!path) throw new Error('setKey requires a settings path');
  if (backup && exists(path)) {
    const bak = path + '.cdbak-settings';
    if (!exists(bak)) writeFile(bak, readFile(path, 'utf8'));
  }
  let lastSeen;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const raw = exists(path) ? readFile(path, 'utf8') : '{}\n';
    const obj = JSON.parse(raw);
    writeFile(path, apply(raw, obj, key, value));
    const after = JSON.parse(readFile(path, 'utf8'));
    lastSeen = key in after ? after[key] : undefined;
    const ok = value === undefined ? !(key in after) : lastSeen === value;
    if (ok) return { key, value: value ?? null, attempts: attempt };
  }
  throw new Error(`settings '${key}'='${value}' did not persist after ${retries} attempts (last: ${JSON.stringify(lastSeen)})`);
}
