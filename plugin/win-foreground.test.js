// Foreground co-process tests (#28) — fake child process, no PowerShell, runs on any platform.
// Run: cd plugin && node --test win-foreground.test.js
//
// Two layers:
//   1. createForegroundProbe(...) — the state machine in isolation (ids, orphans, death, respawn)
//   2. startForegroundPoller/foregroundInfo — the cache contract the DIALS read. These matter
//      most: a wrong reading here silently targets the wrong chat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createForegroundProbe } from './src/win-foreground.js';
import { startForegroundPoller, stopForegroundPoller, foregroundInfo } from './src/foreground.js';

// Minimal fake of the child process: stdout is a stream we push reply lines into, stdin
// records what was written so a test can assert the wire format.
function fakePs() {
  const ps = new EventEmitter();
  ps.stdout = new PassThrough();
  ps.stderr = new PassThrough();
  ps.written = [];
  ps.answered = new Set();
  ps.killed = false;
  ps.unrefs = [];                 // records which handles were unref'd (see the #30 test below)
  ps.unref = () => ps.unrefs.push('proc');
  ps.stdout.unref = () => ps.unrefs.push('stdout');
  ps.stderr.unref = () => ps.unrefs.push('stderr');
  ps.stdin = { write: (s) => { ps.written.push(s); return true; } };
  ps.stdin.unref = () => ps.unrefs.push('stdin');
  ps.stdin.on = (ev, fn) => { (ps.stdinListeners ||= {})[ev] = fn; };
  ps.kill = () => { ps.killed = true; ps.emit('exit', 0); };
  ps.say = (line) => ps.stdout.write(line + '\n');
  ps.ready = () => ps.say('READY');
  // Oldest command still awaiting a reply. Tests MUST answer by this rather than by
  // `written.find(startsWith('fg '))` — the poller issues one `fg` per tick, and matching the
  // first one replies to a command that already timed out.
  ps.nextUnanswered = (verb = 'fg') =>
    ps.written.find((s) => !ps.answered.has(s) && s.startsWith(verb + ' '));
  ps.reply = (payload, verb = 'fg') => {
    const cmd = ps.nextUnanswered(verb);
    if (!cmd) return null;
    ps.answered.add(cmd);
    ps.say(`${cmd.split(' ')[1].trim()}|${payload}`);
    return cmd;
  };
  return ps;
}
const tick = () => new Promise((r) => setImmediate(r));
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
}
const mk = (ps) => createForegroundProbe({ platform: 'win32', spawnFn: () => ps });

// ---------------------------------------------------------------- probe state machine

test('non-Windows platform returns an inert probe that never spawns', async () => {
  let spawned = false;
  const p = createForegroundProbe({ platform: 'darwin', spawnFn: () => { spawned = true; return fakePs(); } });
  p.start();
  assert.equal(spawned, false, 'must not spawn PowerShell off Windows');
  assert.equal(p.isAlive(), false);
  assert.equal(await p.read(), null, 'inert probe reads null so foreground.js uses osascript/xdotool');
  p.stop();
});

test('read() issues one `fg` carrying a monotonic id and returns the pid\\tname payload', async () => {
  const ps = fakePs(); const p = mk(ps);
  p.start(); ps.ready(); await tick();
  const r = p.read();
  await tick();
  assert.match(ps.nextUnanswered(), /^fg \d+\n$/, 'the command carries an id');
  ps.reply('4242\tWindowsTerminal');
  assert.equal(await r, '4242\tWindowsTerminal');
  // Second read reuses the SAME process and bumps the id — this is the whole point of #28.
  const r2 = p.read();
  await tick();
  assert.equal(ps.written.length, 2, 'no respawn between reads');
  const ids = ps.written.map((s) => Number(s.split(' ')[1]));
  assert.ok(ids[1] > ids[0], 'ids are monotonic');
  ps.reply('99\tCode');
  assert.equal(await r2, '99\tCode');
  p.stop();
});

test('an orphan reply from a timed-out command is DROPPED, not paired to the next command', async () => {
  const ps = fakePs(); const p = mk(ps);
  p.start(); ps.ready(); await tick();
  const r = p.read();
  await tick();
  assert.ok(ps.nextUnanswered(), 'the fg must have reached the wire');
  ps.say('999999|1234\tWindowsTerminal');   // wrong id — must be ignored
  await tick();
  const settled = await Promise.race([r.then(() => 'settled'), tick().then(() => 'pending')]);
  assert.equal(settled, 'pending', 'an orphan must not resolve the in-flight read — that skew would target the previously-focused chat forever');
  p.stop();
});

test('co-process death mid-command settles the caller with null instead of hanging it', async () => {
  const ps = fakePs(); const p = mk(ps);
  p.start(); ps.ready(); await tick();
  const r = p.read();
  await tick();
  ps.emit('exit', 1);                       // die mid-command
  assert.equal(await r, null, 'must resolve, not hang for the full 2000ms timeout');
  p.stop();
});

test('ERR (no foreground window / vanished pid) reads as null, not a bogus pid', async () => {
  const ps = fakePs(); const p = mk(ps);
  p.start(); ps.ready(); await tick();
  const r = p.read();
  await tick();
  ps.reply('ERR');
  assert.equal(await r, null);
  p.stop();
});

test('read() before READY is null, and never writes to a co-process that cannot answer', async () => {
  const ps = fakePs(); const p = mk(ps);
  p.start();                                 // no ready()
  assert.equal(await p.read(), null);
  assert.equal(ps.written.length, 0, 'nothing may be queued against an unready loop');
  p.stop();
});

test('death respawns with backoff; stop() cancels the respawn and ignores the dying process', async () => {
  let spawnCount = 0;
  const first = fakePs();
  let latest = first;
  const p = createForegroundProbe({ platform: 'win32', spawnFn: () => { spawnCount++; latest = spawnCount === 1 ? first : fakePs(); return latest; } });
  p.start(); first.ready(); await tick();
  assert.equal(spawnCount, 1);
  first.emit('exit', 1);
  assert.ok(await waitFor(() => spawnCount === 2), 'a dead co-process must respawn');
  p.stop();
  latest.emit('exit', 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(spawnCount, 2, 'no respawn after stop()');
});

test('the child AND all three pipes are unref\'d — shutdown.js layer 2 depends on it (#30)', async () => {
  // A spawned child with piped stdio is FOUR ref'd libuv handles. If any stays ref'd, a CLEAN
  // Stream Deck socket close (no error, no signal, so shutdown.run() never fires) leaves node
  // alive forever holding the bundle's sharp DLLs — the exact zombie #30 was written to kill.
  const ps = fakePs(); const p = mk(ps);
  p.start(); ps.ready(); await tick();
  assert.deepEqual([...ps.unrefs].sort(), ['proc', 'stderr', 'stdin', 'stdout'],
    'every handle the co-process owns must be unref\'d at spawn');
  p.stop();
});

test('stdin errors are absorbed — an escaped EPIPE would fake a dropped Stream Deck socket', async () => {
  // EPIPE is in shutdown.js's CONNECTION_LOSS set. Stream 'error' is emitted asynchronously, so
  // the try/catch around write() cannot catch it; only this listener can.
  const ps = fakePs(); const p = mk(ps);
  p.start(); ps.ready(); await tick();
  assert.equal(typeof ps.stdinListeners?.error, 'function', 'stdin must have an error listener');
  assert.doesNotThrow(() => ps.stdinListeners.error(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
  p.stop();
});

test('stop() DURING the respawn backoff cancels the armed timer, and start() spawns exactly one', async () => {
  // The scenario scheduleRespawn()'s comment describes: an orphan timer surviving a stop/start
  // would spawn a SECOND PowerShell whose handle overwrites `ps` and is never killed.
  const made = [];
  const p = createForegroundProbe({ platform: 'win32', spawnFn: () => { const f = fakePs(); made.push(f); return f; } });
  p.start(); made[0].ready(); await tick();
  assert.equal(made.length, 1);
  made[0].emit('exit', 1);                   // arms the 500ms respawn
  p.stop();                                  // ...and stop it before it fires
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(made.length, 1, 'stop() during backoff must cancel the armed respawn');
  p.start();
  assert.equal(made.length, 2, 'start() spawns exactly one');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(made.length, 2, 'no orphan timer may spawn a third');
  p.stop();
});

test('stop() kills the co-process — it must not become the orphan #30 exists to prevent', async () => {
  const ps = fakePs(); const p = mk(ps);
  p.start(); ps.ready(); await tick();
  p.stop();
  assert.ok(ps.written.includes('quit\n'), 'the loop is asked to exit cleanly');
  assert.equal(ps.killed, true, 'and killed as a backstop');
  assert.equal(p.isAlive(), false);
});

// ---------------------------------------------------------------- the cache the dials read

test('the poller resolves pid + isTerminal from the co-process and keeps the parents snapshot', async () => {
  const ps = fakePs();
  let snapshots = 0;
  startForegroundPoller({
    intervalMs: 20, platform: 'win32', spawnFn: () => ps,
    snapshot: async () => { snapshots++; return { 4242: 100, 100: 1 }; },
  });
  ps.ready();
  assert.ok(await waitFor(() => ps.nextUnanswered()), 'a tick reached the wire');
  ps.reply('4242\tWindowsTerminal');
  assert.ok(await waitFor(() => foregroundInfo().pid === 4242), 'cache picked up the reading');
  assert.deepEqual(foregroundInfo(), { pid: 4242, isTerminal: true, parents: { 4242: 100, 100: 1 } });
  assert.ok(snapshots > 0, 'snapshotParents() is still part of the same refresh (proctree feeds isDescendant)');
  stopForegroundPoller();
});

test('isTerminal is the RESOLVED name against the allowlist — VS Code is NOT a terminal', async () => {
  const ps = fakePs();
  startForegroundPoller({ intervalMs: 20, platform: 'win32', spawnFn: () => ps, snapshot: async () => ({}) });
  ps.ready();
  assert.ok(await waitFor(() => ps.nextUnanswered()));
  ps.reply('777\tCode');
  assert.ok(await waitFor(() => foregroundInfo().pid === 777));
  assert.equal(foregroundInfo().isTerminal, false,
    'a blanket per-platform true here would make every model press refuse instead of routing to the bridge');
  stopForegroundPoller();
});

test('an unresolvable NAME still keeps the pid — dropping it would lose a valid CLI route', async () => {
  // Observed live: the old execFile command returned a bare pid with no name when Get-Process
  // lost the race against an exiting foreground process. pickCompactRoute matches CLI markers
  // (and their descendants) against fg.pid, so the pid must survive a nameless reading.
  const ps = fakePs();
  startForegroundPoller({ intervalMs: 20, platform: 'win32', spawnFn: () => ps, snapshot: async () => ({ 555: 4242 }) });
  ps.ready();
  assert.ok(await waitFor(() => ps.nextUnanswered()));
  ps.reply('4242\t');                        // pid, empty name
  assert.ok(await waitFor(() => foregroundInfo().pid === 4242));
  assert.equal(foregroundInfo().isTerminal, false, 'an empty name tests false against TERMINALS');
  assert.deepEqual(foregroundInfo().parents, { 555: 4242 }, 'descendant matching still has its snapshot');
  stopForegroundPoller();
});

test('ONE co-process serves many ticks — no per-tick spawn (the #28 acceptance criterion)', async () => {
  const ps = fakePs();
  let spawnCount = 0;
  startForegroundPoller({ intervalMs: 10, platform: 'win32', spawnFn: () => { spawnCount++; return ps; }, snapshot: async () => ({}) });
  ps.ready();
  assert.ok(await waitFor(() => ps.written.filter((s) => s.startsWith('fg ')).length >= 1));
  // Answer every tick so the non-overlap guard keeps letting new ones through.
  for (let i = 0; i < 5; i++) { ps.reply(`${1000 + i}\tCode`); await new Promise((r) => setTimeout(r, 15)); }
  assert.ok(ps.written.filter((s) => s.startsWith('fg ')).length >= 3, 'ticks kept flowing');
  assert.equal(spawnCount, 1, 'exactly one PowerShell for the whole poll lifetime');
  stopForegroundPoller();
});

test('a dead co-process degrades the cache to the single-session fallback, it does not latch stale', async () => {
  const ps = fakePs();
  startForegroundPoller({ intervalMs: 20, platform: 'win32', spawnFn: () => ps, snapshot: async () => ({}) });
  ps.ready();
  assert.ok(await waitFor(() => ps.nextUnanswered()));
  ps.reply('4242\tWindowsTerminal');
  assert.ok(await waitFor(() => foregroundInfo().pid === 4242));
  ps.emit('exit', 1);                        // co-process dies; the fake never comes back ready
  assert.ok(await waitFor(() => foregroundInfo().pid === null),
    'a stale pid would keep routing presses at a window that may no longer be focused');
  assert.deepEqual(foregroundInfo(), { pid: null, isTerminal: false, parents: {} });
  stopForegroundPoller();
});

test('foregroundInfo() is SYNCHRONOUS — it is read on the dial press path', async () => {
  const ps = fakePs();
  startForegroundPoller({ intervalMs: 20, platform: 'win32', spawnFn: () => ps, snapshot: async () => ({}) });
  ps.ready();
  assert.ok(await waitFor(() => ps.nextUnanswered()));
  ps.reply('4242\tCode');
  assert.ok(await waitFor(() => foregroundInfo().pid === 4242));
  const v = foregroundInfo();
  assert.equal(typeof v, 'object');
  assert.equal(typeof v.then, 'undefined', 'must be a plain cache read, never a promise');
  assert.equal(v.pid, 4242);
  stopForegroundPoller();
});

test('stopForegroundPoller() clears the interval and the cache, and is safe to call twice', async () => {
  const ps = fakePs();
  const t = startForegroundPoller({ intervalMs: 20, platform: 'win32', spawnFn: () => ps, snapshot: async () => ({}) });
  assert.ok(t, 'still returns the interval handle so shutdown.addTimer() keeps working');
  ps.ready();
  assert.ok(await waitFor(() => ps.nextUnanswered()));
  stopForegroundPoller();
  assert.equal(ps.killed, true);
  const before = ps.written.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ps.written.length, before, 'no ticks after stop');
  assert.deepEqual(foregroundInfo(), { pid: null, isTerminal: false, parents: {} });
  stopForegroundPoller();                    // idempotent — shutdown.js may run closers once, but must not throw
});
