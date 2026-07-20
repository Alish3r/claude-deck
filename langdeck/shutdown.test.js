// Lang Cycle process-lifecycle tests (#34): the plugin must exit when the Stream Deck socket
// drops, must NOT exit on an ordinary bug, and must leave no handle holding the event loop
// open — including winlang.js's co-process, which is four ref'd handles on its own.
// Run: cd langdeck && node --test shutdown.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createShutdown, installProcessHandlers, isConnectionLoss } from './src/shutdown.js';
import { createWinLang } from './src/winlang.js';

// --- classification -------------------------------------------------------------------

test('isConnectionLoss: structured socket codes are connection loss', () => {
  for (const code of ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED']) {
    assert.equal(isConnectionLoss(Object.assign(new Error('boom'), { code })), true, code);
  }
});

test('isConnectionLoss: bare ws error carrying the code only in the message', () => {
  // The literal shape seen in the crash log: "uncaughtException: Error: read ECONNRESET".
  assert.equal(isConnectionLoss(new Error('read ECONNRESET')), true);
});

test('isConnectionLoss: a code nested one level in .cause still counts', () => {
  assert.equal(isConnectionLoss(Object.assign(new Error('wrapped'), { cause: { code: 'EPIPE' } })), true);
});

test('isConnectionLoss: ordinary bugs are NOT connection loss', () => {
  assert.equal(isConnectionLoss(new TypeError('winlang.getState is not a function')), false);
  assert.equal(isConnectionLoss(Object.assign(new Error('nope'), { code: 'ENOENT' })), false);
  // Near-miss: contains "reconnect" and "reset" but neither as a whole word code. The word
  // boundaries in CODE_RE are what keep this false — a substring match would exit here.
  assert.equal(isConnectionLoss(new Error('failed to reconnect to the reset service')), false);
  assert.equal(isConnectionLoss(new Error('ECONNRESETTING the layout cache')), false);
  assert.equal(isConnectionLoss(null), false);
  assert.equal(isConnectionLoss(undefined), false);
});

// --- shutdown routine -----------------------------------------------------------------

test('run(): clears timers, then runs closers IN ORDER, then exits 0', async () => {
  const order = [];
  const exits = [];
  const sd = createShutdown({ exit: (c) => exits.push(c), log: () => {} });

  let ticks = 0;
  sd.addTimer(setInterval(() => { ticks++; }, 1));
  sd.addCloser(() => order.push('winlang.stop'));
  sd.addCloser(() => order.push('second'));

  await sd.run('test');

  await new Promise((r) => setTimeout(r, 20));
  const settled = ticks;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ticks, settled, 'interval kept firing after shutdown');
  assert.deepEqual(order, ['winlang.stop', 'second']);
  assert.deepEqual(exits, [0]);
});

test('addTimer() unrefs so a registered interval alone cannot hold the event loop', () => {
  const sd = createShutdown({ exit: () => {} });
  const t = sd.addTimer(setInterval(() => {}, 1000));
  assert.equal(t.hasRef(), false);
  clearInterval(t);
});

test('run(): a throwing closer does not block the remaining closers or the exit', async () => {
  const exits = [];
  const seen = [];
  const sd = createShutdown({ exit: (c) => exits.push(c), log: (m) => seen.push(m) });
  sd.addCloser(() => { throw new Error('co-process already gone'); });
  sd.addCloser(() => seen.push('second ran'));

  await sd.run('test');
  assert.ok(seen.includes('second ran'));
  assert.ok(seen.some((m) => m.includes('shutdown closer failed')));
  assert.deepEqual(exits, [0]);
});

test('run(): a hanging closer still exits via the watchdog', async () => {
  const exits = [];
  let fire = null;
  const sd = createShutdown({
    exit: (c) => exits.push(c),
    setTimer: (fn) => { fire = fn; return { unref() {} }; },
    clearTimer: () => {},
  });
  sd.addCloser(() => new Promise(() => {}));   // never settles

  const running = sd.run('test');
  assert.equal(typeof fire, 'function', 'no watchdog was armed');
  fire();
  assert.deepEqual(exits, [0], 'watchdog did not force the exit');
  void running;
});

test('run(): idempotent — a signal racing an ECONNRESET exits once', async () => {
  const exits = [];
  let closes = 0;
  const sd = createShutdown({ exit: (c) => exits.push(c), log: () => {} });
  sd.addCloser(() => { closes++; });

  const first = await sd.run('ECONNRESET');
  const second = await sd.run('SIGTERM');
  assert.equal(first, true);
  assert.equal(second, false, 'second shutdown was not suppressed');
  assert.equal(closes, 1, 'closers ran twice');
  assert.deepEqual(exits, [0]);
});

// --- process wiring -------------------------------------------------------------------

test('installProcessHandlers: a dropped socket triggers shutdown', async () => {
  const proc = new EventEmitter();
  const exits = [];
  const sd = createShutdown({ exit: (c) => exits.push(c), log: () => {} });
  installProcessHandlers(sd, { proc });

  proc.emit('uncaughtException', new Error('read ECONNRESET'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(exits, [0]);
});

test('installProcessHandlers: an ordinary uncaughtException does NOT exit', async () => {
  const proc = new EventEmitter();
  const exits = [];
  const sd = createShutdown({ exit: (c) => exits.push(c), log: () => {} });
  installProcessHandlers(sd, { proc });

  proc.emit('uncaughtException', new TypeError('langKey.repaint is not a function'));
  proc.emit('unhandledRejection', new Error('sharp failed to rasterize'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(exits, [], 'a plain bug must stay a logged crash, not a silent restart loop');
  assert.equal(sd.started, false);
});

test('installProcessHandlers: SIGTERM/SIGINT shut the plugin down', async () => {
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const proc = new EventEmitter();
    const exits = [];
    const sd = createShutdown({ exit: (c) => exits.push(c), log: () => {} });
    installProcessHandlers(sd, { proc });
    proc.emit(sig);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(exits, [0], sig);
  }
});

// --- layer 2: winlang.stop() as a registered closer --------------------------------------

test('winlang.stop() registered as a closer actually stops the co-process on shutdown', async () => {
  const ps = new EventEmitter();
  ps.stdout = new PassThrough();
  ps.stderr = new PassThrough();
  ps.stdin = { write: () => true, on: () => {}, unref: () => {} };
  ps.unref = () => {}; ps.stdout.unref = () => {}; ps.stderr.unref = () => {};
  let killed = 0;
  ps.kill = () => { killed++; ps.emit('exit', 0); };

  const w = createWinLang({ intervalMs: 10_000, platform: 'win32', spawnFn: () => ps });
  const exits = [];
  const sd = createShutdown({ exit: (c) => exits.push(c), log: () => {} });
  sd.addCloser(() => w.stop());
  w.start();

  await sd.run('ECONNRESET');
  assert.equal(killed, 1, 'the PowerShell co-process outlived the shutdown');
  assert.equal(w.getState().alive, false);
  assert.deepEqual(exits, [0]);
});
