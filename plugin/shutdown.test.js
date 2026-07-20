// Tests for the plugin's process lifecycle (#30): the plugin must exit when the Stream
// Deck socket drops, must NOT exit on an ordinary bug, and must not leave any interval
// holding the event loop open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createShutdown, installProcessHandlers, isConnectionLoss } from './src/shutdown.js';
import { createRelayHub } from './src/relay-hub.js';
import { createCliHub } from './src/cli-hub.js';

const memIo = (files = {}) => ({
  readdir: () => Object.keys(files), read: (p) => files[p], write: (p, d) => { files[p] = d; },
  rename: (a, b) => { files[b] = files[a]; delete files[a]; }, unlink: (p) => { delete files[p]; },
  exists: (p) => p in files, mtime: () => Date.now(),
});

// --- classification -------------------------------------------------------------------

test('isConnectionLoss: structured socket codes are connection loss', () => {
  for (const code of ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED']) {
    assert.equal(isConnectionLoss(Object.assign(new Error('boom'), { code })), true, code);
  }
});

test('isConnectionLoss: bare ws error carrying the code only in the message', () => {
  // This is the literal shape seen in the crash log: "uncaughtException: Error: read ECONNRESET"
  assert.equal(isConnectionLoss(new Error('read ECONNRESET')), true);
});

test('isConnectionLoss: a code nested one level in .cause still counts', () => {
  assert.equal(isConnectionLoss(Object.assign(new Error('wrapped'), { cause: { code: 'EPIPE' } })), true);
});

test('isConnectionLoss: ordinary bugs are NOT connection loss', () => {
  assert.equal(isConnectionLoss(new TypeError('x.foo is not a function')), false);
  assert.equal(isConnectionLoss(Object.assign(new Error('nope'), { code: 'ENOENT' })), false);
  assert.equal(isConnectionLoss(new Error('failed to reconnect to the reset service')), false);
  assert.equal(isConnectionLoss(null), false);
  assert.equal(isConnectionLoss(undefined), false);
});

// --- shutdown routine -----------------------------------------------------------------

test('run(): clears timers, then closes the hub, then exits 0', async () => {
  const order = [];
  const exits = [];
  const sd = createShutdown({ exit: (c) => exits.push(c), log: () => {} });

  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  sd.addTimer(timer);
  const hub = { closed: 0, close: () => { order.push('hub.close'); hub.closed++; } };
  sd.addCloser(() => hub.close());
  sd.addCloser(() => order.push('poller._stop'));

  await sd.run('test');

  await new Promise((r) => setTimeout(r, 20));
  const settled = ticks;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ticks, settled, 'interval kept firing after shutdown');
  assert.equal(hub.closed, 1, 'hub.close() was not called');
  assert.deepEqual(order, ['hub.close', 'poller._stop']);
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
  sd.addCloser(() => { throw new Error('server already gone'); });
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
  sd.addCloser(() => new Promise(() => {})); // never settles

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
  assert.equal(closes, 1);
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

  proc.emit('uncaughtException', new TypeError('ctl.tick is not a function'));
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

// --- belt and braces: no poller may pin the loop on its own -----------------------------

test('relay-hub + cli-hub result pollers are unref\'d and stoppable', () => {
  const relay = createRelayHub({ io: memIo(), dir: '/x', readEffortFn: () => 'high' });
  const cli = createCliHub({ io: memIo(), dir: '/x' });
  assert.equal(relay._timer.hasRef(), false, 'relay-hub poller would keep the process alive');
  assert.equal(cli._timer.hasRef(), false, 'cli-hub poller would keep the process alive');
  relay._stop();
  cli._stop();
});
