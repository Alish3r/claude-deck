import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClaude, pickExecutable } from './src/resolve-claude.js';

test('honors CLAUDE_DECK_CLAUDE_BIN override', () => {
  assert.equal(resolveClaude({ env: { CLAUDE_DECK_CLAUDE_BIN: '/opt/claude' }, which: () => null }), '/opt/claude');
});
test('falls back to a which/where lookup (Windows .cmd shim)', () => {
  assert.equal(resolveClaude({ env: {}, which: () => 'C:/Users/x/AppData/Roaming/npm/claude.cmd' }), 'C:/Users/x/AppData/Roaming/npm/claude.cmd');
});
test('defaults to bare "claude" when nothing resolves', () => {
  assert.equal(resolveClaude({ env: {}, which: () => null }), 'claude');
});

// The real on-host bug: `where claude` lists the extensionless shell shim FIRST, then claude.cmd.
// ConPTY error 193 (bad-exe) on the shim → the launcher crashed on startup before this fix.
test('pickExecutable prefers .cmd over the extensionless shim on Windows', () => {
  const lines = ['C:\\Users\\x\\AppData\\Roaming\\npm\\claude', 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd'];
  assert.equal(pickExecutable(lines, 'win32'), 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd');
});
test('pickExecutable takes the first line on non-Windows', () => {
  assert.equal(pickExecutable(['/usr/local/bin/claude', '/opt/claude'], 'linux'), '/usr/local/bin/claude');
});
test('pickExecutable falls back to line[0] when no Win32 extension is present', () => {
  assert.equal(pickExecutable(['C:\\tools\\claude'], 'win32'), 'C:\\tools\\claude');
});
test('pickExecutable returns null for empty/blank output', () => {
  assert.equal(pickExecutable(['', '   ', ''], 'win32'), null);
  assert.equal(pickExecutable([], 'linux'), null);
});
