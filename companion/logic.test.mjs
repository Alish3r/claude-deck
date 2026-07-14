// Companion logic tests — pure decision/health logic + the multi-window lock
// coordination (real patcher on temp copies). No VS Code. Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decideAction, healthLabel, classifyApplyError } from './src/logic.mjs';
import { apply, status } from '../patch/patcher.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'patch', '__fixtures__');
function stage() {
  const d = mkdtempSync(join(tmpdir(), 'cd-comp-'));
  mkdirSync(join(d, 'webview'), { recursive: true });
  cpSync(join(FIX, 'extension.js'), join(d, 'extension.js'));
  cpSync(join(FIX, 'webview', 'index.js'), join(d, 'webview', 'index.js'));
  return d;
}
const clean = (d) => rmSync(d, { recursive: true, force: true });

test('decideAction: pristine -> patch, patched -> noop, partial -> repair, broken -> read-only', () => {
  assert.equal(decideAction({ patched: false, partial: false }).action, 'patch');
  assert.equal(decideAction({ patched: true, partial: false }).action, 'noop');
  assert.equal(decideAction({ patched: false, partial: true }).action, 'repair');
  assert.equal(decideAction({ broken: true }).action, 'read-only');
});

test('healthLabel maps every state to a status-bar label', () => {
  assert.equal(healthLabel({ patched: false }).state, 'pristine');
  assert.equal(healthLabel({ patched: true }).state, 'patched');
  assert.equal(healthLabel({ patched: true }, { reloadPending: true }).state, 'reload-needed');
  assert.equal(healthLabel({ patched: false, partial: true }).state, 'read-only');
  assert.equal(healthLabel({ patched: true }, { broken: true }).state, 'broken');
});

test('classifyApplyError distinguishes lock vs drift vs syntax', () => {
  assert.equal(classifyApplyError('patch in progress (lock held by pid 5)'), 'locked');
  assert.equal(classifyApplyError('anchor [H-mgr] matched 0x (expected 1)'), 'anchors');
  assert.equal(classifyApplyError('node --check failed for extension.js'), 'syntax');
  assert.equal(classifyApplyError('disk full'), 'other');
});

test('multi-window: a held lock makes a second window refuse to patch', () => {
  const d = stage();
  try {
    // simulate another window mid-patch by planting a fresh lock
    writeFileSync(join(d, '.cd-lock.json'), JSON.stringify({ pid: 999999, ts: Date.now() }));
    assert.throws(() => apply(d), /patch in progress/i);
    assert.equal(status(d).patched, false, 'no patch applied while locked');
  } finally { clean(d); }
});

test('staggered: once one window has patched, the next decides noop (exactly one patches)', () => {
  const d = stage();
  try {
    apply(d);                                   // window 1 patches
    assert.equal(status(d).patched, true);
    assert.equal(decideAction(status(d)).action, 'noop'); // window 2 sees patched -> noop
  } finally { clean(d); }
});
