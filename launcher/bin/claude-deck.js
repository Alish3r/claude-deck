#!/usr/bin/env node
// claude-deck — run INSTEAD of `claude`. PTY-wraps the real CLI (prebuilt node-pty) for a
// transparent session and exposes an idle-gated /compact channel to the plugin via the %TEMP%
// relay. Writes to an OWNED fd — never OS input. See docs/superpowers/specs.
let ptySpawn;
try { ({ spawn: ptySpawn } = await import('@lydell/node-pty')); }
catch (e) { fail(`node-pty failed to load (${(e && e.code) || e}).`); }
if (typeof ptySpawn !== 'function') fail('node-pty loaded but has no spawn() — bad/mismatched prebuild.');
function fail(msg) {
  process.stderr.write(`claude-deck: ${msg}\nReinstall:  cd <claude-deck>/launcher && npm install\n`);
  process.exit(127);
}

import { readdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPtyHost } from '../src/pty-host.js';
import { createIdleDetector } from '../src/idle-detector.js';
import { planCommand } from '../src/control.js';
import { buildMarker, writeMarker, writeAlive, removeMarker } from '../src/registry.js';
import { resolveClaude } from '../src/resolve-claude.js';
import { killTree, watchParent } from '../src/contain.js';

const DIR = tmpdir();
const id = process.pid.toString(36) + (process.hrtime.bigint() % 1000000n).toString(36); // NO Math.floor(BigInt)
const detector = createIdleDetector();
let childPid = null;

// Windows CreateProcess cannot exec a `.cmd`/`.ps1` shim directly — wrap it in `cmd.exe /c`.
const claudeBin = resolveClaude();
const isShim = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(claudeBin);
const spawnFile = isShim ? (process.env.ComSpec || 'cmd.exe') : claudeBin;
const spawnArgs = isShim ? ['/c', claudeBin, ...process.argv.slice(2)] : process.argv.slice(2);

const host = createPtyHost({
  file: spawnFile, args: spawnArgs,
  cols: process.stdout.columns || 80, rows: process.stdout.rows || 24,
  cwd: process.cwd(), env: process.env,
  spawn: (file, args, opts) => { const p = ptySpawn(file, args, opts); childPid = p.pid; return p; },
  sink: (d) => process.stdout.write(d),
  onData: (d) => detector.feed(d),
  onExit: (code) => { cleanup(); process.exit(code); },
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (buf) => host.write(buf));                 // Buffer through — binary-safe
process.stdout.on('resize', () => host.resize(process.stdout.columns, process.stdout.rows));

writeMarker(buildMarker({ id, pid: process.pid, ppid: process.ppid, cwd: process.cwd(), now: Date.now() }), { dir: DIR });
const beat = setInterval(() => writeAlive(id, Date.now(), { dir: DIR }), 2000);
const guard = watchParent(() => { cleanup(); process.exit(0); });

let resSeq = 0;
const writeResult = (r) => { const p = join(DIR, `claude-deck-cli-res-${id}-${++resSeq}.json`); try { writeFileSync(p + '.tmp', JSON.stringify(r)); renameSync(p + '.tmp', p); } catch { /* ignore */ } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (pred()) return true; await sleep(50); } return false; }
async function runPlan(plan) {
  for (const step of plan.steps) { if (step.text) host.write(step.text); else if (step.settleMs) await sleep(step.settleMs); }
  if (plan.verify) {
    // EDGE-LATCH: a fast compaction may start+finish between polls, so ask whether a turn STARTED
    // (busy footer/spinner) since we armed — not the level state at poll time.
    const armed = Date.now();
    await sleep(400);
    const started = detector.sawBusySince(armed) || (await waitFor(() => detector.sawBusySince(armed), 1200));
    writeResult({ ...plan.result, ok: started, reason: started ? undefined : 'unconfirmed' });
  } else writeResult(plan.result);
}

const pre = `claude-deck-cli-cmd-${id}-`;
let inFlight = false;                                  // single-flight: no interleaved /compact writes
const poll = setInterval(async () => {
  if (inFlight) return;
  let names; try { names = readdirSync(DIR).filter((f) => f.startsWith(pre) && f.endsWith('.json')).sort(); } catch { return; }
  for (const name of names) {
    const full = join(DIR, name);
    let cmd; try { cmd = JSON.parse(readFileSync(full, 'utf8')); } catch { continue; }
    try { unlinkSync(full); } catch { continue; }                 // claim by unlink; only act if it succeeds
    const plan = planCommand(cmd, detector.state());
    if (plan.refuse) { writeResult(plan.result); continue; }
    inFlight = true;
    try { await runPlan(plan); } finally { inFlight = false; }
  }
}, 250);

function cleanup() { clearInterval(beat); clearInterval(poll); clearInterval(guard); removeMarker(id, { dir: DIR }); killTree(childPid); host.kill(); }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
