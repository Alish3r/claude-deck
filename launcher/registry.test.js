import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarker, writeMarker, removeMarker } from './src/registry.js';

function memFs() {
  const files = new Map();                              // keyed by full path (OS-native separators)
  const base = (p) => p.split(/[\\/]/).pop();
  return { files, base, io: {
    writeFileSync: (p, d) => files.set(p, d),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    chmodSync: () => {}, rmSync: (p) => files.delete(p), existsSync: (p) => files.has(p),
  } };
}
const get = (files, base, name) => { for (const [k, v] of files) if (base(k) === name) return v; };

test('buildMarker captures identity incl. start time', () => {
  assert.deepEqual(buildMarker({ id: 'abc', pid: 42, ppid: 7, cwd: '/x', now: 1000 }),
    { id: 'abc', pid: 42, ppid: 7, cwd: '/x', startedAt: 1000 });
});

test('writeMarker is atomic (tmp+rename) + chmod 0600; removeMarker deletes marker + alive', () => {
  const { files, base, io } = memFs();
  writeMarker(buildMarker({ id: 'abc', pid: 42, ppid: 7, cwd: '/x', now: 1000 }), { dir: '/tmp', io });
  assert.equal(JSON.parse(get(files, base, 'claude-deck-cli-abc.json')).pid, 42);
  assert.equal([...files.keys()].some((k) => k.endsWith('.tmp')), false);
  removeMarker('abc', { dir: '/tmp', io });
  assert.equal([...files.keys()].some((k) => base(k) === 'claude-deck-cli-abc.json'), false);
});
