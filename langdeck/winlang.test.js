// winlang state-machine tests — fake child process, no PowerShell, runs on any platform.
// Run: cd plugin && node --test winlang.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWinLang } from './src/winlang.js';
import { langFace } from './src/lang-logic.js';

// Minimal fake of the child process: stdout is a stream we push reply lines into, stdin
// records what was written so a test can assert the wire format.
function fakePs() {
  const ps = new EventEmitter();
  ps.stdout = new PassThrough();
  ps.stderr = new PassThrough();
  ps.written = [];
  ps.answered = new Set();
  ps.unrefs = [];                 // records which handles were unref'd (see the #34 test below)
  ps.unref = () => ps.unrefs.push('proc');
  ps.stdout.unref = () => ps.unrefs.push('stdout');
  ps.stderr.unref = () => ps.unrefs.push('stderr');
  ps.stdin = { write: (s) => { ps.written.push(s); return true; } };
  ps.stdin.unref = () => ps.unrefs.push('stdin');
  ps.stdin.on = (ev, fn) => { (ps.stdinListeners ||= {})[ev] = fn; };
  ps.kill = () => ps.emit('exit', 0);
  ps.say = (line) => ps.stdout.write(line + '\n');
  ps.ready = () => ps.say('READY');
  // Oldest command still awaiting a reply. Tests MUST answer by this rather than by
  // `written.find(startsWith('get '))` — several `get`s occur (the READY-chained read, then
  // each read-back), and matching the first one replies to the wrong command.
  ps.nextUnanswered = (verb) =>
    ps.written.find((s) => !ps.answered.has(s) && (!verb || s.startsWith(verb + ' ')));
  // Replies to the oldest unanswered command, echoing its id. Returns the command, or null.
  ps.reply = (payload, verb) => {
    const cmd = ps.nextUnanswered(verb);
    if (!cmd) return null;
    ps.answered.add(cmd);
    ps.say(`${cmd.split(' ')[1].trim()}|${payload}`);
    return cmd;
  };
  return ps;
}
const STATE = '04090409|04190419,04090409|123';
const mk = (ps) => createWinLang({ intervalMs: 10_000, platform: 'win32', spawnFn: () => ps });
const tick = () => new Promise((r) => setImmediate(r));

// Bring the co-process to a usable state. On READY it issues TWO commands, chained: `preload`,
// then an immediate `get`. BOTH hold the transaction mutex and both must be answered — a test
// that answers neither (or only preload) has every later command starved behind the unanswered
// one and sees an empty wire. Two drafts of these tests failed exactly that way.
async function boot(ps) {
  ps.ready();
  await tick();
  ps.reply('00000409,00000419', 'preload');
  await tick();
  ps.reply(STATE, 'get');           // the READY-chained first read
  await tick();
}

test('non-Windows platform returns an inert stub that never spawns', async () => {
  let spawned = false;
  const w = createWinLang({ platform: 'darwin', spawnFn: () => { spawned = true; return fakePs(); } });
  w.start();
  assert.equal(spawned, false, 'must not spawn PowerShell off Windows');
  assert.equal(w.getState().alive, false);
  assert.deepEqual(await w.setLayout('04090409'), { ok: false, confirmed: null, reason: 'unsupported-platform' });
  w.stop();
});

test('commands carry a monotonic id on the wire', async () => {
  const ps = fakePs(); const w = mk(ps);
  w.start(); await boot(ps);
  const p = w.setLayout('04190419');
  await tick();
  assert.match(ps.nextUnanswered('set'), /^set \d+ 04190419\n$/, 'set carries an id and the target hkl');
  ps.reply('POSTED=True', 'set');
  await tick();
  // Answer the follow-up read-back too, or this test sits out the full 2000ms timeout. Using
  // nextUnanswered matters: a plain find('get ') would match the READY-chained read instead.
  await new Promise((r) => setTimeout(r, 150));   // setLayout waits 120ms before reading back
  ps.reply('04190419|04190419,04090409|123', 'get');
  await p.catch(() => {});
  w.stop();
});

test('an orphan reply from a timed-out command is DROPPED, not paired to the next command', async () => {
  const ps = fakePs(); const w = mk(ps);
  w.start(); await boot(ps);
  // Send a command and never answer it; then answer with a STALE id.
  const first = w.setLayout('04190419');
  await tick();
  ps.say('999999|04090409|04190419,04090409|123');   // wrong id — must be ignored
  await tick();
  // Prove the command actually reached the wire. Without this assertion a STUCK mutex would
  // also leave the promise 'pending', so the test would pass for entirely the wrong reason.
  assert.ok(ps.written.some((s) => s.startsWith('set ')), 'the set must have been issued');
  // The in-flight command must still be waiting, not resolved by the orphan.
  const settled = await Promise.race([first.then(() => 'settled'), tick().then(() => 'pending')]);
  assert.equal(settled, 'pending', 'orphan reply must not resolve the in-flight command');
  w.stop();
});

test('co-process death settles the in-flight caller instead of hanging it', async () => {
  const ps = fakePs(); const w = mk(ps);
  w.start(); await boot(ps);
  const p = w.setLayout('04190419');
  await tick();
  ps.emit('exit', 1);                                 // die mid-command
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-coprocess', 'must resolve, not hang for the full timeout');
  w.stop();
});

test('a slow-but-alive co-process reports timeout, not no-coprocess', async () => {
  const ps = fakePs();
  const w = createWinLang({ intervalMs: 10_000, platform: 'win32', spawnFn: () => ps, });
  w.start(); await boot(ps);
  // Never answer the `set`; the command must time out while the process is still alive.
  const res = await w.setLayout('04190419');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'timeout', 'a slow co-process must not be reported as absent');
  w.stop();
});

test('setLayout never reports ok when the read-back did not happen', async () => {
  const ps = fakePs(); const w = mk(ps);
  w.start(); await boot(ps);
  const p = w.setLayout('04190419');
  await tick();
  ps.reply('POSTED=True', 'set');                     // post succeeds...
  await tick();
  ps.emit('exit', 1);                                 // ...but the process dies before read-back
  const res = await p;
  assert.equal(res.ok, false, 'ok must never come from cached state');
  assert.equal(res.confirmed, null);
  assert.equal(res.reason, 'stale');
  w.stop();
});

test('concurrent setLayout calls do not interleave: each gets its own read-back', async () => {
  const ps = fakePs(); const w = mk(ps);
  w.start(); await boot(ps);
  const a = w.setLayout('04190419');
  const b = w.setLayout('04090409');
  await tick();
  // Only ONE set should be on the wire — the second waits for the first transaction to finish.
  assert.equal(ps.written.filter((s) => s.startsWith('set ')).length, 1,
    'the second transaction must not post while the first is settling');
  w.stop();
  await Promise.allSettled([a, b]);
});

test('stop() prevents respawn and ignores the dying process events', async () => {
  const ps = fakePs(); const w = mk(ps);
  let spawnCount = 0;
  const w2 = createWinLang({ intervalMs: 10_000, platform: 'win32', spawnFn: () => { spawnCount++; return ps; } });
  w2.start(); ps.ready(); await tick();
  assert.equal(spawnCount, 1);
  w2.stop();
  ps.emit('exit', 0);
  await tick();
  assert.equal(spawnCount, 1, 'no respawn after stop()');
  w.stop();
});

test('stop() marks the state dead so the key cannot render a stale language', async () => {
  const ps = fakePs(); const w = mk(ps);
  w.start(); await boot(ps);
  assert.equal(w.getState().alive, true);
  assert.equal(w.getState().hkl, '04090409');
  w.stop();
  assert.equal(w.getState().alive, false, 'stop() must mirror the exit handler');
  // langFace is what the key face is derived from — it must fall back to the placeholder.
  assert.deepEqual(langFace(w.getState()), { label: null, state: 'starting' });
});

test('preload is read over the same co-process, not a second PowerShell', async () => {
  const ps = fakePs(); const w = mk(ps);
  w.start(); ps.ready(); await tick();
  assert.ok(ps.nextUnanswered('preload'), 'preload is a command on the existing loop (locked decision: ONE co-process)');
  ps.reply('00000409,00000419', 'preload');
  await tick();
  assert.deepEqual(w.getPreload(), ['00000409', '00000419']);
  // And it must NOT have spawned a second PowerShell to read the registry.
  assert.equal(ps.written.filter((s) => s.startsWith('preload ')).length, 1);
  w.stop();
});

test('the child AND all three pipes are unref\'d — shutdown.js layer 2 depends on it (#34)', async () => {
  // A spawned child with piped stdio is FOUR ref'd libuv handles. If any stays ref'd, a CLEAN
  // Stream Deck socket close (no error, no signal, so shutdown.run() never fires) leaves node
  // alive forever holding the bundle's sharp DLLs and an orphan powershell.exe — the exact
  // zombie #30 was written to kill, recreated here because langdeck never got that treatment.
  const ps = fakePs(); const w = mk(ps);
  w.start(); await boot(ps);
  assert.deepEqual([...ps.unrefs].sort(), ['proc', 'stderr', 'stdin', 'stdout'],
    'every handle the co-process owns must be unref\'d at spawn');
  w.stop();
});

test('a respawned co-process is unref\'d too — not just the first one (#34)', async () => {
  // The respawn path is the one that runs for the rest of the plugin's life; an unref applied
  // only to the initial spawn would silently regress after the first PowerShell death.
  const made = [];
  const w = createWinLang({ intervalMs: 10_000, platform: 'win32', spawnFn: () => { const f = fakePs(); made.push(f); return f; } });
  w.start(); await boot(made[0]);
  made[0].emit('exit', 1);                       // arms the 500ms respawn
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(made.length, 2, 'no respawn happened — the test asserts nothing');
  assert.deepEqual([...made[1].unrefs].sort(), ['proc', 'stderr', 'stdin', 'stdout']);
  w.stop();
});

test('stdin errors are absorbed — an escaped EPIPE would fake a dropped Stream Deck socket', async () => {
  // EPIPE is in shutdown.js's CONNECTION_LOSS set. Stream 'error' is emitted ASYNCHRONOUSLY, so
  // rawSend's try/catch around write() cannot catch it; only this listener can. Without it the
  // error becomes an uncaughtException that installProcessHandlers classifies as connection
  // loss, and a dying PowerShell would shut the whole plugin down.
  const ps = fakePs(); const w = mk(ps);
  w.start(); await boot(ps);
  assert.equal(typeof ps.stdinListeners?.error, 'function', 'stdin must have an error listener');
  assert.doesNotThrow(() => ps.stdinListeners.error(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
  w.stop();
});
