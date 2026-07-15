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

import { locateExtensionDir, status, verify, apply, revert, guardedApply } from './patcher.js';
import { readEffort, setEffort, defaultSettingsPath, EFFORT_LADDER } from './effort.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--guard') args.guard = true;
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--settings') args.settings = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

const USAGE = `claude-deck patch CLI
  node patch/cli.mjs status  [--dir <ext-dir>]
  node patch/cli.mjs verify  [--dir <ext-dir>]
  node patch/cli.mjs apply   [--dir <ext-dir>] [--dry-run] [--guard [--timeout <ms>]]
  node patch/cli.mjs revert  [--dir <ext-dir>]
  node patch/cli.mjs effort  [get | <auto|low|medium|high|xhigh|ultracode>] [--settings <path>]

  --guard   apply, then auto-revert unless the patched host emits a fresh
            heartbeat within --timeout ms (default 10000) of you reloading.
  effort    ⊙GLOBAL — reads/writes ~/.claude/settings.json:effortLevel (closed-loop).`;

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
        console.log(`state: ${tag}${s.version ? ` (v${s.version})` : ''}${s.extVersion ? ` · claude-code ${s.extVersion}` : ''}${s.locked ? ' [locked]' : ''}`);
        if (s.extChanged) {
          console.log(`  ⚠ patched against claude-code ${s.patchedExtVersion}, live is ${s.extVersion} — the anchors are version-specific.`);
          console.log(`    run \`node patch/cli.mjs apply --dry-run\` to check they still fit, or \`revert\` first.`);
        } else if (s.patched) {
          console.log(`  note: a VS Code extension update replaces this folder and drops the patch — re-run setup / \`apply\` to re-apply.`);
        }
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
        const dir = resolveDir(args);
        if (args.guard) {
          // a non-numeric --timeout parses to NaN; NaN defeats the guard (setTimeout(NaN)
          // fires immediately OR the >= comparison never trips) — clamp to a sane default
          const timeoutMs = Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : 10_000;
          // guardedApply applies internally — announce arming, not a done-deal apply
          console.log(`arming guarded apply — reload the VS Code window once it says applied; watching ${Math.round(timeoutMs / 1000)}s for the host heartbeat…`);
          guardedApply(dir, { timeoutMs })
            .then((r) => {
              if (r.alive) console.log(`host alive after ${r.waitedMs}ms — patch confirmed (v${r.version ?? '?'})`);
              else { console.error(`no heartbeat within ${timeoutMs}ms — AUTO-REVERTED to pristine`); process.exitCode = 1; }
            })
            .catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
        } else {
          const r = apply(dir, { dryRun: args.dryRun });
          console.log(r.dryRun ? `dry-run OK — would patch: ${r.wouldPatch.join(', ')}` : `applied (v${r.version})`);
        }
        break;
      }
      case 'revert': {
        const r = revert(resolveDir(args));
        console.log(r.reverted.length ? `reverted: ${r.reverted.join(', ')}` : 'nothing to revert (already pristine)');
        break;
      }
      case 'effort': {
        // ⊙GLOBAL effort control (writes ~/.claude/settings.json). Read is safe;
        // a set against the real settings file is the consequential action.
        const settings = args.settings || defaultSettingsPath();
        const sub = args._[1];
        if (!sub || sub === 'get') {
          console.log(`effort (global): ${readEffort(settings)}   [${settings}]`);
        } else {
          if (!EFFORT_LADDER.includes(sub)) { console.error(`level must be one of: ${EFFORT_LADDER.join(' | ')}`); process.exit(1); }
          const r = setEffort(settings, sub);
          console.log(`effort set to '${r.level}' (settings=${r.settingsLevel ?? 'unset'}${r.ultracode ? ', ultracode' : ''}) in ${r.attempts} attempt(s)`);
        }
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
