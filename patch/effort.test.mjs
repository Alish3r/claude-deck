// ⊙GLOBAL effort controller tests — real temp settings files + an in-memory fs for the
// closed-loop retry/persistence guard. The real ~/.claude/settings.json is never touched.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveEffort, readEffort, setEffort, EFFORT_LADDER, SETTINGS_KEY } from './effort.js';

function tmpSettings(content) {
  const dir = mkdtempSync(join(tmpdir(), 'cd-settings-'));
  const p = join(dir, 'settings.json');
  writeFileSync(p, content);
  return { p, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A tiny in-memory fs so we can simulate a write that silently fails to persist —
// exactly the setEffortLevel ok:true-but-not-written failure mode from M1.
function memfs(initial) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    readFile: (p) => { if (!store.has(p)) throw new Error('ENOENT'); return store.get(p); },
    writeFile: (p, d) => store.set(p, d),
    exists: (p) => store.has(p),
    rename: (a, b) => { if (!store.has(a)) throw new Error('ENOENT'); store.set(b, store.get(a)); store.delete(a); },
  };
}

test('resolveEffort maps every ladder position', () => {
  assert.deepEqual(resolveEffort('auto'), { settingsLevel: undefined, ultracode: false });
  for (const l of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(resolveEffort(l), { settingsLevel: l, ultracode: false });
  }
  assert.deepEqual(resolveEffort('ultracode'), { settingsLevel: 'xhigh', ultracode: true });
  assert.throws(() => resolveEffort('bogus'), /unknown effort level/);
});

test('readEffort returns auto when unset, the value when present', () => {
  const a = tmpSettings('{\n  "other": 1\n}\n');
  const b = tmpSettings('{\n  "effortLevel": "high"\n}\n');
  try {
    assert.equal(readEffort(a.p), 'auto');
    assert.equal(readEffort(b.p), 'high');
  } finally { a.cleanup(); b.cleanup(); }
});

test('setEffort changes the value, preserves all other keys, and reads back', () => {
  const s = tmpSettings('{\n  "permissions": { "allow": ["x"] },\n  "effortLevel": "xhigh",\n  "z": true\n}\n');
  try {
    const r = setEffort(s.p, 'low');
    assert.equal(r.settingsLevel, 'low');
    assert.equal(r.attempts, 1);
    const obj = JSON.parse(readFileSync(s.p, 'utf8'));
    assert.equal(obj.effortLevel, 'low');
    assert.deepEqual(obj.permissions, { allow: ['x'] }, 'unrelated keys preserved');
    assert.equal(obj.z, true);
  } finally { s.cleanup(); }
});

test('setEffort targeted edit preserves the rest of the file byte-for-byte', () => {
  const raw = '{\n  "permissions": {\n    "allow": ["a", "b"]\n  },\n  "effortLevel": "xhigh"\n}\n';
  const s = tmpSettings(raw);
  try {
    setEffort(s.p, 'medium');
    const after = readFileSync(s.p, 'utf8');
    assert.equal(after, raw.replace('"xhigh"', '"medium"'), 'only the effort value line changed');
  } finally { s.cleanup(); }
});

test("setEffort 'auto' removes the key, keeping other keys", () => {
  const s = tmpSettings('{\n  "effortLevel": "high",\n  "keep": 1\n}\n');
  try {
    const r = setEffort(s.p, 'auto');
    assert.equal(r.settingsLevel, null);
    const obj = JSON.parse(readFileSync(s.p, 'utf8'));
    assert.equal(SETTINGS_KEY in obj, false, 'effortLevel removed');
    assert.equal(obj.keep, 1);
    assert.equal(readEffort(s.p), 'auto');
  } finally { s.cleanup(); }
});

test('setEffort inserts the key when absent', () => {
  const s = tmpSettings('{\n  "keep": 1\n}\n');
  try {
    setEffort(s.p, 'xhigh');
    assert.equal(JSON.parse(readFileSync(s.p, 'utf8')).effortLevel, 'xhigh');
    assert.equal(JSON.parse(readFileSync(s.p, 'utf8')).keep, 1);
  } finally { s.cleanup(); }
});

test("'ultracode' writes xhigh to settings and flags ultracode for the webview", () => {
  const s = tmpSettings('{\n  "effortLevel": "low"\n}\n');
  try {
    const r = setEffort(s.p, 'ultracode');
    assert.equal(r.settingsLevel, 'xhigh');
    assert.equal(r.ultracode, true);
    assert.equal(JSON.parse(readFileSync(s.p, 'utf8')).effortLevel, 'xhigh');
  } finally { s.cleanup(); }
});

test('backs up the original settings once before the first write', () => {
  const s = tmpSettings('{\n  "effortLevel": "xhigh"\n}\n');
  try {
    setEffort(s.p, 'low');
    const bak = s.p + '.cdbak-settings';
    assert.ok(existsSync(bak), 'backup created');
    assert.equal(JSON.parse(readFileSync(bak, 'utf8')).effortLevel, 'xhigh', 'backup holds the original');
    // second write must not overwrite the (already-pristine) backup
    setEffort(s.p, 'high');
    assert.equal(JSON.parse(readFileSync(bak, 'utf8')).effortLevel, 'xhigh');
  } finally { s.cleanup(); }
});

test('closed-loop guard THROWS when a write silently fails to persist (the setEffortLevel trap)', () => {
  const fs = memfs({ '/s.json': '{\n  "effortLevel": "xhigh"\n}\n' });
  const noPersist = { ...fs, writeFile: () => { /* pretend the write vanished — value stays xhigh */ } };
  assert.throws(
    () => setEffort('/s.json', 'low', noPersist),
    /did not persist after 3 attempts \(last seen: "xhigh"\)/,
  );
});

test('closed-loop guard succeeds on a flaky writer that lands on a later attempt', () => {
  const fs = memfs({ '/s.json': '{\n  "effortLevel": "xhigh"\n}\n' });
  let n = 0;
  const flaky = {
    ...fs,
    // first write is dropped, second lands. backup:false so only the effort writes count.
    writeFile: (p, d) => { n++; if (n >= 2) fs.writeFile(p, d); },
  };
  const r = setEffort('/s.json', 'low', { ...flaky, backup: false });
  assert.equal(r.attempts, 2);
  assert.equal(JSON.parse(fs.readFile('/s.json')).effortLevel, 'low');
});

test('setEffort never corrupts settings whose stored value contains escapes (falls back to reserialize)', () => {
  const fs = memfs({ '/s.json': JSON.stringify({ effortLevel: 'weird\\"value', other: 1 }, null, 2) });
  const r = setEffort('/s.json', 'high', { ...fs, backup: false });
  const after = JSON.parse(fs.readFile('/s.json')); // parse throwing here IS the corruption regression
  assert.equal(after.effortLevel, 'high');
  assert.equal(after.other, 1, 'other keys preserved');
  assert.equal(r.settingsLevel, 'high');
});

test('setEffort edits the TOP-LEVEL effortLevel, not a same-named nested key that appears first', () => {
  // a nested object carries "effortLevel" textually BEFORE the authoritative top-level key
  const fs = memfs({ '/s.json': JSON.stringify({ mcp: { effortLevel: 'low' }, effortLevel: 'high' }, null, 2) });
  setEffort('/s.json', 'max', { ...fs, backup: false });
  const after = JSON.parse(fs.readFile('/s.json'));
  assert.equal(after.effortLevel, 'max', 'top-level key updated');
  assert.equal(after.mcp.effortLevel, 'low', 'the nested same-named key is untouched');
});

test('setEffort writes are atomic: no .cdtmp remnants left behind', () => {
  const fs = memfs({ '/s.json': '{\n  "effortLevel": "low"\n}\n' });
  setEffort('/s.json', 'max', { ...fs, backup: false });
  assert.equal([...fs.store.keys()].some((k) => k.includes('.cdtmp')), false);
  assert.equal(JSON.parse(fs.readFile('/s.json')).effortLevel, 'max');
});

test('EFFORT_LADDER is the expected ordered ladder', () => {
  // no 'auto' rung: the Claude Code picker has no Auto entry (enum low..max) — auto is a
  // display-only state for an absent settings key, not a dialable position (#31)
  assert.deepEqual(EFFORT_LADDER, ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
});
