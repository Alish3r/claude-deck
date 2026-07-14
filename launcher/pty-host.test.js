import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPtyHost } from './src/pty-host.js';

function fakePty() {
  const dataCbs = [], exitCbs = [];
  return { written: [], resized: [], killed: false,
    onData: (cb) => dataCbs.push(cb), onExit: (cb) => exitCbs.push(cb),
    write(d) { this.written.push(d); }, resize(c, r) { this.resized.push([c, r]); }, kill() { this.killed = true; },
    _data: (d) => dataCbs.forEach((cb) => cb(d)), _exit: (e) => exitCbs.forEach((cb) => cb(e)) };
}
const mk = (pty, over = {}) => createPtyHost({ file: 'claude', args: [], cols: 80, rows: 24, spawn: () => pty, sink: () => {}, onExit: () => {}, onData: () => {}, ...over });

test('forwards output to sink + onData; exit code to onExit', () => {
  const pty = fakePty(); let sunk = '', code = null;
  mk(pty, { sink: (d) => { sunk += d; }, onExit: (c) => { code = c; } });
  pty._data('hello'); assert.equal(sunk, 'hello');
  pty._exit({ exitCode: 3 }); assert.equal(code, 3);
});

test('write/kill delegate; resize AFTER exit does NOT throw (node-pty #827 guard)', () => {
  const pty = fakePty(); const host = mk(pty);
  host.write('/compact'); assert.deepEqual(pty.written, ['/compact']);
  host.resize(120, 40); assert.deepEqual(pty.resized, [[120, 40]]);
  pty._exit({ exitCode: 0 });
  assert.doesNotThrow(() => host.resize(200, 50));   // guarded: skipped after exit
  assert.deepEqual(pty.resized, [[120, 40]], 'no resize after exit');
});
