#!/usr/bin/env node
// claude-deck patch CLI — apply | revert | status | verify
//
// Usage:
//   node patch/cli.mjs status  [--dir <ext-dir>]
//   node patch/cli.mjs verify  [--dir <ext-dir>]
//   node patch/cli.mjs apply   [--dir <ext-dir>] [--dry-run]
//   node patch/cli.mjs revert  [--dir <ext-dir>]
//
// --dir defaults to the highest-version anthropic.claude-code-* under the user's
// VS Code extensions directory (the LIVE extension). apply/revert against the live
// extension are consequential — this repo's workflow gates them on human approval.

import { locateExtensionDir, status, verify, apply, revert } from './patcher.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

const USAGE = `claude-deck patch CLI
  node patch/cli.mjs status  [--dir <ext-dir>]
  node patch/cli.mjs verify  [--dir <ext-dir>]
  node patch/cli.mjs apply   [--dir <ext-dir>] [--dry-run]
  node patch/cli.mjs revert  [--dir <ext-dir>]`;

function resolveDir(args) {
  const dir = args.dir || locateExtensionDir();
  if (!args.dir) console.log(`(located extension: ${dir})`);
  return dir;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || !cmd) { console.log(USAGE); process.exit(cmd ? 0 : 1); }

  try {
    switch (cmd) {
      case 'status': {
        const s = status(resolveDir(args));
        const tag = s.patched ? 'PATCHED' : s.partial ? 'PARTIAL(!)' : 'pristine';
        console.log(`state: ${tag}${s.version ? ` (v${s.version})` : ''}${s.locked ? ' [locked]' : ''}`);
        for (const [file, f] of Object.entries(s.files)) {
          console.log(`  ${file.padEnd(8)} ${f.exists ? (f.patched ? 'patched' : 'pristine') : 'MISSING'}${f.backup ? ' +bak' : ''}`);
        }
        break;
      }
      case 'verify': {
        const v = verify(resolveDir(args));
        for (const r of v.results) {
          console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  [${r.id}] ${r.file} ${r.got}/${r.want}`);
        }
        console.log(v.ok ? 'ANCHORS: OK' : 'ANCHORS: MISMATCH');
        process.exit(v.ok ? 0 : 1);
        break;
      }
      case 'apply': {
        const r = apply(resolveDir(args), { dryRun: args.dryRun });
        console.log(r.dryRun ? `dry-run OK — would patch: ${r.wouldPatch.join(', ')}` : `applied (v${r.version})`);
        break;
      }
      case 'revert': {
        const r = revert(resolveDir(args));
        console.log(r.reverted.length ? `reverted: ${r.reverted.join(', ')}` : 'nothing to revert (already pristine)');
        break;
      }
      default:
        console.error(`unknown command: ${cmd}\n\n${USAGE}`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

main();
