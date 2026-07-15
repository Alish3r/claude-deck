#!/usr/bin/env node
// One-shot installer for Claude Deck: plugin deps -> patch apply -> plugin build.
//   node setup.mjs        (or:  npm run setup)
//
// Safe to re-run: skips `npm install` if plugin/node_modules exists, skips the patch
// if the extension is already patched. Every step is closed-loop (verified from disk,
// not trusted from a promise) per this repo's development-workflow convention.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateExtensionDir, status as patchStatus } from './patch/patcher.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const step = (n, msg) => console.log(`\n[${n}/4] ${msg}`);
// npm/npx are .cmd shims on Windows — Windows can exec them directly via the
// .cmd extension (no shell:true needed, which would unsafely re-concatenate args).
const winCmd = (name) => (process.platform === 'win32' ? `${name}.cmd` : name);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`\n✗ failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
};

console.log('Claude Deck setup');

// --- requirements -----------------------------------------------------------
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`✗ Node 20+ required (found ${process.version})`);
  process.exit(1);
}
if (!['win32', 'darwin'].includes(process.platform)) {
  console.warn(`! untested platform (${process.platform}) — proceeding anyway`);
}

let extDir;
try {
  extDir = locateExtensionDir();
} catch (e) {
  console.error(`✗ Claude Code VS Code extension not found: ${e.message}`);
  console.error('  Install it from the VS Code marketplace first, then re-run this script.');
  process.exit(1);
}
console.log(`✓ found Claude Code extension: ${extDir}`);

// --- 1. plugin dependencies ---------------------------------------------------
step(1, 'installing plugin dependencies (esbuild, sharp, @elgato/*)');
if (existsSync(join(HERE, 'plugin', 'node_modules'))) {
  console.log('  already installed, skipping (delete plugin/node_modules to force)');
} else {
  run(winCmd('npm'), ['install'], { cwd: join(HERE, 'plugin') });
}

// --- 2. patch (closed-loop: apply, then re-read status from disk) ------------
step(2, 'patching the Claude Code extension (reversible)');
const before = patchStatus(extDir);
if (before.patched) {
  console.log(`  already patched (v${before.version}) — skipping apply`);
} else {
  run(process.execPath, [join(HERE, 'patch', 'cli.mjs'), 'apply']);
}
const after = patchStatus(extDir);
if (!after.patched) {
  console.error('✗ patch verify failed after apply — extension not in a patched state');
  console.error('  run `node patch/cli.mjs status` for details');
  process.exit(1);
}
console.log(`✓ patch verified (v${after.version}, closed-loop read-back from disk)`);

// --- 3. build + side-load the Stream Deck plugin ------------------------------
step(3, 'building the Stream Deck plugin + side-loading it');
// Best-effort: a running plugin instance holds its native binaries (sharp) open,
// which makes the copy-over-in-place step below fail with EPIPE/EBUSY on Windows.
// No-op (and harmless) on a first-time install where nothing is running yet.
spawnSync(winCmd('npx'), ['@elgato/cli', 'stop', 'com.alisher.claude-deck'], {
  cwd: join(HERE, 'plugin'),
  stdio: 'ignore',
});
run(process.execPath, [join(HERE, 'plugin', 'build.mjs')]);

// --- 4. what's left (can't be scripted: GUI-only steps) -----------------------
step(4, "two manual steps left (can't be scripted)");
console.log(`
  1. In VS Code: "Developer: Reload Window"   (Ctrl/Cmd+Shift+P)
  2. In the Stream Deck app: add the Model and Effort dial actions

If the plugin doesn't show up in the Stream Deck app:
  npx @elgato/cli restart com.alisher.claude-deck
`);
console.log('Done — Claude Deck is installed.');
