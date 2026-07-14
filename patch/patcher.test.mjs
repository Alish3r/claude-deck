// Unit tests for the patch engine — run entirely on synthetic fixtures + temp copies.
// The live extension is never touched. Run: node --test  (or: npm test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  apply, revert, status, verify, locateExtensionDir, patchOne,
} from './patcher.js';
import { MARK } from './anchors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const parses = (p) => { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); return true; };

// Stage a fresh temp "extension dir" laid out like the real one:
//   <dir>/extension.js  and  <dir>/webview/index.js
function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'cd-test-'));
  mkdirSync(join(dir, 'webview'), { recursive: true });
  cpSync(join(FIXTURES, 'extension.js'), join(dir, 'extension.js'));
  cpSync(join(FIXTURES, 'webview', 'index.js'), join(dir, 'webview', 'index.js'));
  return dir;
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test('verify passes on a pristine fixture (all anchors exact)', () => {
  const dir = stage();
  try {
    const v = verify(dir);
    assert.ok(v.ok, 'expected all anchors to pass:\n' + JSON.stringify(v.results, null, 2));
    // sanity: the multi-site anchor is counted as 3
    const hmsg = v.results.find((r) => r.id === 'H-msg');
    assert.equal(hmsg.got, 3);
  } finally { cleanup(dir); }
});

test('apply patches both files atomically, writes state + backups, stays valid JS', () => {
  const dir = stage();
  try {
    const r = apply(dir);
    assert.equal(r.patched, true);

    const s = status(dir);
    assert.equal(s.patched, true, 'both files should be patched');
    assert.equal(s.partial, false);
    assert.ok(s.version, 'state version recorded');

    for (const rel of ['extension.js', 'webview/index.js']) {
      const p = join(dir, rel);
      assert.ok(readFileSync(p, 'utf8').includes(MARK), `${rel} should carry the marker`);
      assert.ok(existsSync(p + '.cdbak'), `${rel}.cdbak should exist`);
      assert.ok(parses(p), `${rel} should still be valid JS`);
    }
    assert.ok(existsSync(join(dir, '.cd-state.json')));
  } finally { cleanup(dir); }
});

test('revert restores byte-identical pristine and clears markers/backups/state', () => {
  const dir = stage();
  try {
    const before = {
      host: readFileSync(join(dir, 'extension.js'), 'utf8'),
      web: readFileSync(join(dir, 'webview/index.js'), 'utf8'),
    };
    apply(dir);
    const rr = revert(dir);
    assert.deepEqual(rr.reverted.sort(), ['host', 'webview']);

    const after = {
      host: readFileSync(join(dir, 'extension.js'), 'utf8'),
      web: readFileSync(join(dir, 'webview/index.js'), 'utf8'),
    };
    assert.equal(sha(after.host), sha(before.host), 'host restored byte-identical');
    assert.equal(sha(after.web), sha(before.web), 'webview restored byte-identical');
    assert.ok(!after.host.includes(MARK) && !after.web.includes(MARK), 'markers gone');
    assert.ok(!existsSync(join(dir, 'extension.js.cdbak')), 'backup removed');
    assert.ok(!existsSync(join(dir, '.cd-state.json')), 'state removed');
    assert.equal(status(dir).patched, false);
  } finally { cleanup(dir); }
});

test('apply is idempotent-safe: a second apply refuses (no double-patch)', () => {
  const dir = stage();
  try {
    apply(dir);
    assert.throws(() => apply(dir), /already patched/i);
    // marker count unchanged by the refused second apply
    const host = readFileSync(join(dir, 'extension.js'), 'utf8');
    const markers = host.split(MARK).length - 1;
    assert.ok(markers >= 4, `expected the host markers intact, got ${markers}`);
  } finally { cleanup(dir); }
});

test('corrupt anchor => refuse, and NEITHER file is patched (both-or-neither)', () => {
  const dir = stage();
  try {
    // break the host H-mgr anchor only; webview stays intact
    const hp = join(dir, 'extension.js');
    writeFileSync(hp, readFileSync(hp, 'utf8').replace('sessionPanels=new Map', 'sessionPanelsX=new Map'));

    assert.throws(() => apply(dir), /anchor verification failed|refusing to patch/i);

    const host = readFileSync(hp, 'utf8');
    const web = readFileSync(join(dir, 'webview/index.js'), 'utf8');
    assert.ok(!host.includes(MARK), 'host must remain unpatched');
    assert.ok(!web.includes(MARK), 'webview must remain unpatched (not written despite valid anchors)');
    assert.ok(!existsSync(hp + '.cdbak'), 'no backup written on refusal');
    assert.ok(!existsSync(join(dir, '.cd-state.json')), 'no state written on refusal');
  } finally { cleanup(dir); }
});

test('verify reports the specific failing anchor on drift', () => {
  const dir = stage();
  try {
    const wp = join(dir, 'webview/index.js');
    writeFileSync(wp, readFileSync(wp, 'utf8').replace('acquireVsCodeApi()', 'acquireVsCodeApiX()'));
    const v = verify(dir);
    assert.equal(v.ok, false);
    const wapi = v.results.find((r) => r.id === 'W-api');
    assert.equal(wapi.pass, false);
    assert.equal(wapi.got, 0);
  } finally { cleanup(dir); }
});

test('dry-run verifies + parses but writes nothing', () => {
  const dir = stage();
  try {
    const r = apply(dir, { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.verified, true);
    assert.equal(status(dir).patched, false, 'dry-run must not patch');
    assert.ok(!existsSync(join(dir, '.cd-state.json')));
    assert.ok(!existsSync(join(dir, 'extension.js.cdbak')));
  } finally { cleanup(dir); }
});

test('patchOne throws on unexpected anchor count (never writes a partial splice)', () => {
  const dir = stage();
  try {
    const broken = readFileSync(join(dir, 'extension.js'), 'utf8').replace('sessionPanels=new Map', 'nope');
    assert.throws(() => patchOne('host', broken), /anchor \[H-mgr\]/);
  } finally { cleanup(dir); }
});

test('locateExtensionDir picks the highest-version anthropic.claude-code-* dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'cd-extroot-'));
  try {
    for (const n of [
      'anthropic.claude-code-2.1.9-win32-x64',
      'anthropic.claude-code-2.1.207-win32-x64',
      'anthropic.claude-code-2.1.10-win32-x64',
      'some.other-extension-1.0.0',
    ]) mkdirSync(join(root, n));
    const picked = locateExtensionDir(root);
    assert.ok(picked.endsWith('anthropic.claude-code-2.1.207-win32-x64'), `picked ${picked}`);
  } finally { cleanup(root); }
});
