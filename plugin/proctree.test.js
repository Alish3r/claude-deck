import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDescendant } from './src/proctree.js';

const tree = { 500: 400, 400: 300, 300: 0 }; // launcher 500 <- shell 400 <- terminal 300
test('descendant chain resolves', () => {
  assert.equal(isDescendant(500, 300, tree), true);
  assert.equal(isDescendant(500, 400, tree), true);
});
test('non-descendant returns false; cycles/missing terminate', () => {
  assert.equal(isDescendant(500, 999, tree), false);
  assert.equal(isDescendant(500, 500, tree), false);
  assert.equal(isDescendant(1, 2, {}), false);
});
