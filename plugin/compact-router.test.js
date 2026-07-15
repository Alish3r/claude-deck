import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCompactRoute } from './src/compact-router.js';

const mk = (over) => ({ id: 's1', pid: 500, alive: true, ...over });
const tree = { 500: 400, 400: 300, 300: 0 };   // launcher 500 under terminal 300

test('foreground terminal is an ANCESTOR of a live launcher => that CLI session', () => {
  const r = pickCompactRoute({ fg: { pid: 300, isTerminal: true, parents: tree }, cliMarkers: [mk()], bridgeActive: true });
  assert.deepEqual(r, { via: 'cli', id: 's1' });
});
test('foreground is VS Code (not a terminal) => bridge', () => {
  const r = pickCompactRoute({ fg: { pid: 900, isTerminal: false, parents: tree }, cliMarkers: [mk()], bridgeActive: true });
  assert.deepEqual(r, { via: 'bridge' });
});
test('foreground IS a terminal but no launcher under it => REFUSE (never compact the bridge)', () => {
  const r = pickCompactRoute({ fg: { pid: 700, isTerminal: true, parents: { 500: 400, 400: 300 } }, cliMarkers: [mk()], bridgeActive: true });
  assert.deepEqual(r, { via: 'none' });
});
test('no foreground info, no bridge, one live CLI => that CLI', () => {
  assert.deepEqual(pickCompactRoute({ fg: null, cliMarkers: [mk()], bridgeActive: false }), { via: 'cli', id: 's1' });
});
test('no foreground info, multiple CLI => none (never guess)', () => {
  assert.deepEqual(pickCompactRoute({ fg: null, cliMarkers: [mk(), mk({ id: 's2', pid: 600 })], bridgeActive: false }), { via: 'none' });
});
test('dead marker under a focused terminal => REFUSE (never fall through to the bridge)', () => {
  // s1's launcher sits under terminal 300, but the marker is dead. No LIVE match under the
  // focused terminal => refuse. Routing to the bridge here would compact a chat the user isn't looking at.
  assert.deepEqual(pickCompactRoute({ fg: { pid: 300, isTerminal: true, parents: tree }, cliMarkers: [mk({ alive: false })], bridgeActive: true }), { via: 'none' });
});
test('dead marker + foreground is VS Code (not a terminal) => bridge', () => {
  assert.deepEqual(pickCompactRoute({ fg: { pid: 900, isTerminal: false, parents: tree }, cliMarkers: [mk({ alive: false })], bridgeActive: true }), { via: 'bridge' });
});
