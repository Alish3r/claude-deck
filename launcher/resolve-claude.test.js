import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClaude } from './src/resolve-claude.js';

test('honors CLAUDE_DECK_CLAUDE_BIN override', () => {
  assert.equal(resolveClaude({ env: { CLAUDE_DECK_CLAUDE_BIN: '/opt/claude' }, which: () => null }), '/opt/claude');
});
test('falls back to a which/where lookup (Windows .cmd shim)', () => {
  assert.equal(resolveClaude({ env: {}, which: () => 'C:/Users/x/AppData/Roaming/npm/claude.cmd' }), 'C:/Users/x/AppData/Roaming/npm/claude.cmd');
});
test('defaults to bare "claude" when nothing resolves', () => {
  assert.equal(resolveClaude({ env: {}, which: () => null }), 'claude');
});
