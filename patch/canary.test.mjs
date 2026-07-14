// Tests for the two-stage canary — node --check (checkSyntax) + heartbeat watchdog
// (waitForAlive / guardedApply). Runs on synthetic fixtures + temp copies; the live
// extension and the real tmpdir heartbeat are never touched (heartbeat path injected).
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkSyntax, guardedApply, status } from './patcher.js';
import { waitForAlive, readHeartbeat } from './heartbeat.js';
import { MARK } from './anchors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__');
const sha = (s) => createHash('sha256').update(s).digest('hex');

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'cd-canary-'));
  mkdirSync(join(dir, 'webview'), { recursive: true });
  cpSync(join(FIXTURES, 'extension.js'), join(dir, 'extension.js'));
  cpSync(join(FIXTURES, 'webview', 'index.js'), join(dir, 'webview', 'index.js'));
  return dir;
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const hbFile = () => join(mkdtempSync(join(tmpdir(), 'cd-hb-')), 'alive.json');
const writeHb = (p, t) => writeFileSync(p, JSON.stringify({ via: 'mgr-ctor', t }));

// ---- stage 1: checkSyntax --------------------------------------------------

test('checkSyntax passes valid JS and throws on invalid JS', () => {
  assert.doesNotThrow(() => checkSyntax('ok', 'const a = 1; function f(){ return a; }'));
  assert.throws(() => checkSyntax('bad', 'function ('), /node --check failed for bad/);
});

// ---- stage 2: waitForAlive freshness --------------------------------------

test('waitForAlive resolves when a FRESH heartbeat (t >= since) is present', async () => {
  const p = hbFile();
  const since = Date.now();
  writeHb(p, since + 5); // emitted after we armed
  const r = await waitForAlive({ since, path: p, timeoutMs: 500, intervalMs: 20 });
  assert.equal(r.alive, true);
  assert.equal(r.heartbeat.via, 'mgr-ctor');
});

test('waitForAlive rejects a STALE heartbeat (t < since) — no false pass', async () => {
  const p = hbFile();
  const since = Date.now();
  writeHb(p, since - 1000); // left over from a previous session
  const r = await waitForAlive({ since, path: p, timeoutMs: 200, intervalMs: 20 });
  assert.equal(r.alive, false);
});

test('waitForAlive times out to not-alive when no heartbeat appears', async () => {
  const p = join(tmpdir(), 'cd-hb-missing-' + process.pid + '.json');
  const r = await waitForAlive({ since: Date.now(), path: p, timeoutMs: 150, intervalMs: 20 });
  assert.equal(r.alive, false);
  assert.equal(readHeartbeat(p), null);
});

// ---- guardedApply: apply + watchdog + auto-revert -------------------------

test('guardedApply confirms the patch when the host comes alive', async () => {
  const dir = stage();
  const p = hbFile();
  try {
    // onArmed simulates the reload → new host emitting its heartbeat
    const r = await guardedApply(dir, {
      hbPath: p, timeoutMs: 1000,
      onArmed: () => writeHb(p, Date.now()),
    });
    assert.equal(r.alive, true);
    assert.equal(r.reverted, false);
    assert.equal(status(dir).patched, true, 'patch stays applied when alive');
    assert.ok(readFileSync(join(dir, 'extension.js'), 'utf8').includes(MARK));
  } finally { cleanup(dir); }
});

test('guardedApply AUTO-REVERTS to byte-identical pristine when no heartbeat lands', async () => {
  const dir = stage();
  const p = hbFile();
  try {
    const before = {
      host: readFileSync(join(dir, 'extension.js'), 'utf8'),
      web: readFileSync(join(dir, 'webview/index.js'), 'utf8'),
    };
    const r = await guardedApply(dir, { hbPath: p, timeoutMs: 200 }); // no onArmed => host never signals
    assert.equal(r.alive, false);
    assert.equal(r.reverted, true);

    const after = {
      host: readFileSync(join(dir, 'extension.js'), 'utf8'),
      web: readFileSync(join(dir, 'webview/index.js'), 'utf8'),
    };
    assert.equal(sha(after.host), sha(before.host), 'host rolled back byte-identical');
    assert.equal(sha(after.web), sha(before.web), 'webview rolled back byte-identical');
    assert.equal(status(dir).patched, false);
    assert.ok(!existsSync(join(dir, '.cd-state.json')), 'state cleared after auto-revert');
  } finally { cleanup(dir); }
});

test('guardedApply ignores a STALE heartbeat and still auto-reverts', async () => {
  const dir = stage();
  const p = hbFile();
  try {
    writeHb(p, Date.now() - 5000); // pre-existing stale file from a prior session
    const r = await guardedApply(dir, { hbPath: p, timeoutMs: 200 });
    assert.equal(r.alive, false, 'stale heartbeat must not confirm');
    assert.equal(r.reverted, true);
    assert.equal(status(dir).patched, false);
  } finally { cleanup(dir); }
});
