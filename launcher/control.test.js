import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCommand } from './src/control.js';

test('compact while idle => submit plan: text, settle, enter, verify', () => {
  const r = planCommand({ op: 'compact', id: 'model:1' }, 'idle');
  assert.equal(r.refuse, false);
  assert.deepEqual(r.steps, [{ text: '/compact' }, { settleMs: 350 }, { text: '\r' }]);
  assert.equal(r.verify, true);
  assert.deepEqual(r.result, { op: 'compact', ok: true, id: 'model:1' });
});

for (const s of ['busy', 'awaiting-permission', 'unknown']) {
  test(`compact while ${s} => refuse, no steps`, () => {
    const r = planCommand({ op: 'compact', id: 'x' }, s);
    assert.equal(r.refuse, true);
    assert.deepEqual(r.steps, []);
    assert.deepEqual(r.result, { op: 'compact', ok: false, reason: s, id: 'x' });
  });
}

test('unknown op => refuse', () => {
  const r = planCommand({ op: 'frob', id: 'x' }, 'idle');
  assert.equal(r.refuse, true);
  assert.equal(r.result.reason, 'unsupported');
});
