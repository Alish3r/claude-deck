// launcher/src/registry.js — session marker CRUD. Pure; fs injected for tests.
import { writeFileSync, renameSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const defaultIo = { writeFileSync, renameSync, chmodSync, rmSync };
export const markerName = (id) => `claude-deck-cli-${id}.json`;
export const aliveName = (id) => `claude-deck-cli-alive-${id}.json`;
export function buildMarker({ id, pid, ppid, cwd, now }) { return { id, pid, ppid, cwd, startedAt: now }; }

function atomicWrite(io, path, data, mode) {
  io.writeFileSync(path + '.tmp', data); io.renameSync(path + '.tmp', path);
  try { io.chmodSync(path, mode); } catch { /* windows: no-op */ }
}
export function writeMarker(marker, { dir = tmpdir(), io = defaultIo } = {}) {
  atomicWrite(io, join(dir, markerName(marker.id)), JSON.stringify(marker), 0o600);
}
export function writeAlive(id, now, { dir = tmpdir(), io = defaultIo } = {}) {
  atomicWrite(io, join(dir, aliveName(id)), JSON.stringify({ t: now }), 0o600);
}
export function removeMarker(id, { dir = tmpdir(), io = defaultIo } = {}) {
  for (const name of [markerName(id), aliveName(id)]) { try { io.rmSync(join(dir, name)); } catch { /* gone */ } }
}
