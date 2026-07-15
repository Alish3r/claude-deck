import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createCliHub } from './src/cli-hub.js';

function memIo(clock) {
  const files = new Map();
  return { files,
    put(name, obj, mtime = clock.t) { files.set(join('X:/tmp', name), { data: JSON.stringify(obj), mtime }); },
    names() { return [...files.keys()].map((p) => p.split(/[\\/]/).pop()); },
    io: {
      readdir: () => [...files.keys()].map((p) => p.split(/[\\/]/).pop()),
      read: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p).data; },
      write: (p, d) => files.set(p, { data: d, mtime: clock.t }),
      rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
      unlink: (p) => { if (!files.has(p)) throw new Error('ENOENT'); files.delete(p); },
      exists: (p) => files.has(p), mtime: (p) => files.get(p).mtime,
    } };
}

test('startup purges stale cli-res files (no spurious replay)', () => {
  const clock = { t: 100 }; const m = memIo(clock);
  m.put('claude-deck-cli-res-s1-9.json', { op: 'compact', ok: false, reason: 'busy', id: 'x' });
  const hub = createCliHub({ dir: 'X:/tmp', io: m.io, now: () => clock.t, pidAlive: () => true });
  assert.equal(m.names().some((n) => n.startsWith('claude-deck-cli-res-')), false);
  hub._stop();
});

test('liveMarkers returns ONLY alive (fresh stamp + pid alive)', () => {
  const clock = { t: 1_000_000 }; const m = memIo(clock);
  m.put('claude-deck-cli-s1.json', { id: 's1', pid: 100, startedAt: 1 });
  m.put('claude-deck-cli-alive-s1.json', { t: clock.t });
  m.put('claude-deck-cli-s2.json', { id: 's2', pid: 200, startedAt: 1 });
  m.put('claude-deck-cli-alive-s2.json', { t: clock.t - 60_000 }, clock.t - 60_000);     // stale — freshness is judged by mtime (3rd arg), which the launcher heartbeat advances
  m.put('claude-deck-cli-s3.json', { id: 's3', pid: 300, startedAt: 1 });
  m.put('claude-deck-cli-alive-s3.json', { t: clock.t });               // fresh but pid dead
  const hub = createCliHub({ dir: 'X:/tmp', io: m.io, now: () => clock.t, pidAlive: (pid) => pid !== 300 });
  assert.deepEqual(hub.liveMarkers().map((x) => x.id), ['s1']);
  hub._stop();
});

test('sendCompact writes one atomic command file; pollResults consumes+unlinks', () => {
  const clock = { t: 5 }; const m = memIo(clock);
  const hub = createCliHub({ dir: 'X:/tmp', io: m.io, now: () => clock.t, pidAlive: () => true });
  hub.sendCompact('s1');
  assert.equal(m.names().filter((n) => n.startsWith('claude-deck-cli-cmd-s1-')).length, 1);
  assert.ok(!m.names().some((n) => n.endsWith('.tmp')), 'atomic — no tmp remnant');
  m.put('claude-deck-cli-res-s1-1.json', { op: 'compact', ok: false, reason: 'busy', id: 'model:cli' });
  const got = []; hub.onResult((r) => got.push(r)); hub._pollResults();
  assert.equal(got.length, 1);
  assert.equal(m.names().some((n) => n.startsWith('claude-deck-cli-res-')), false);
  hub._stop();
});
