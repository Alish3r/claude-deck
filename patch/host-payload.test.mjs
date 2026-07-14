// Injected HOST-payload tests — run the REAL H_PREPEND string (anchors.js) in a vm sandbox
// with fake os/fs/path/vscode + a mock panel manager, and drive its 350ms poller by hand.
// Covers the tab-switch fix: when mgr.activeSessionId changes, the poller must resync BOTH
// the leaving and entering chats so each re-stamps its per-session `active` flag (a tab
// switch changes no webview signal, so nothing else makes them re-snap). Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { STEPS } from './anchors.js';

const H_PREPEND = STEPS.find((s) => s.id === 'H-prepend').payload;

function fakePanel() {
  const posted = [];
  return { webview: { postMessage: (m) => posted.push(m) }, posted };
}

// Build the sandbox, run H_PREPEND, and expose the captured poll callback + manager hooks.
function hostHarness() {
  const files = new Map();
  const fakeFs = {
    writeFileSync: (p, d) => files.set(p, d),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    readdirSync: () => [...files.keys()].map((p) => p.split('/').pop()),
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    existsSync: (p) => files.has(p),
    unlinkSync: (p) => { files.delete(p); },
  };
  let pollFn = null;
  const requireFn = (name) => {
    if (name === 'os') return { tmpdir: () => '/tmp' };
    if (name === 'fs') return fakeFs;
    if (name === 'path') return { join: (...a) => a.join('/') };
    if (name === 'vscode') return { window: { state: { focused: true }, onDidChangeWindowState: () => {} } };
    throw new Error('unknown module ' + name);
  };
  const sandbox = {
    require: requireFn, Math, Date, JSON, Array, Object, String,
    setInterval: (fn) => { pollFn = fn; return 1; },
  };
  vm.createContext(sandbox);
  vm.runInContext(H_PREPEND, sandbox);
  return { sandbox, files, poll: () => pollFn(), setManager: (m) => { sandbox.__claudeDeck = { mgr: m }; } };
}

test('activeSessionId change resyncs BOTH the leaving and entering chats', () => {
  const h = hostHarness();
  const pA = fakePanel(), pB = fakePanel();
  const mgr = { sessionPanels: new Map([['A', pA], ['B', pB]]), activeSessionId: 'A' };
  h.setManager(mgr);

  h.poll(); // first observation: A is active (prev undefined -> A), resyncs A only
  assert.deepEqual(pA.posted.map((m) => m.op), ['resync'], 'newly-observed active chat re-snaps');
  assert.equal(pB.posted.length, 0);

  mgr.activeSessionId = 'B'; // user switches tab A -> B
  h.poll();
  assert.ok(pB.posted.some((m) => m.op === 'resync'), 'entering chat B is told to re-snap (active:true)');
  assert.equal(pA.posted.filter((m) => m.op === 'resync').length, 2, 'leaving chat A also re-snaps (active:false)');
});

test('no active change => no spurious resyncs (idle poll is quiet)', () => {
  const h = hostHarness();
  const pA = fakePanel();
  const mgr = { sessionPanels: new Map([['A', pA]]), activeSessionId: 'A' };
  h.setManager(mgr);
  h.poll(); // observes A
  const after = pA.posted.length;
  h.poll(); h.poll(); // no change
  assert.equal(pA.posted.length, after, 'stable active session is not re-resynced every tick');
});

test('command files still dispatch to the addressed panel (regression)', () => {
  const h = hostHarness();
  const pA = fakePanel(), pB = fakePanel();
  const mgr = { sessionPanels: new Map([['A', pA], ['B', pB]]), activeSessionId: 'A' };
  h.setManager(mgr);
  const wid = h.sandbox.__cdWID;
  h.files.set(`/tmp/claude-deck-cmd-${wid}-00000000000001-0001.json`, JSON.stringify({ op: 'set_model', value: 'sonnet', sessionId: 'B', id: 'model:1' }));
  h.poll();
  assert.ok(pB.posted.some((m) => m.op === 'set_model' && m.value === 'sonnet'), 'addressed panel B got the command');
});
