// Payload-agnostic patch engine for the Claude Code VS Code extension bundles.
//
// Safety properties (see docs/PLAN.md "Patch safety"):
//   - Anchor counts verified against pristine BEFORE any write; any mismatch aborts.
//   - `node --check` gates both patched bundles before either is written.
//   - Pristine-only `.cdbak` (refuses to back up an already-marked file), hash-keyed.
//   - Atomic both-files-or-neither: stage both, check both, rename both; roll back on
//     a failed second rename using the just-made backups.
//   - Cross-window lockfile (PID + timestamp, stale-detected).
//
// Nothing here targets the live extension implicitly — callers pass the target dir.

import { readFileSync, writeFileSync, existsSync, renameSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { STEPS, VERIFY_ONLY, FILES, MARK, PATCH_VERSION, countMatches } from './anchors.js';
import { waitForAlive, heartbeatPath } from './heartbeat.js';

const STATE_FILE = '.cd-state.json';
const LOCK_FILE = '.cd-lock.json';
const LOCK_STALE_MS = 30_000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const stepsFor = (file) => STEPS.filter((s) => s.file === file);

// --- locate -----------------------------------------------------------------

// Find the highest-version `anthropic.claude-code-*` directory under an extensions
// root (defaults to the user's VS Code extensions dir). Returns an absolute path.
export function locateExtensionDir(extRoot = defaultExtRoot()) {
  if (!existsSync(extRoot)) throw new Error(`extensions root not found: ${extRoot}`);
  const dirs = readdirSync(extRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('anthropic.claude-code-'))
    .map((d) => d.name);
  if (!dirs.length) throw new Error(`no anthropic.claude-code-* extension under ${extRoot}`);
  dirs.sort(compareExtNames);
  return join(extRoot, dirs[dirs.length - 1]);
}

function defaultExtRoot() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('cannot resolve home dir (USERPROFILE/HOME unset)');
  return join(home, '.vscode', 'extensions');
}

// Order `anthropic.claude-code-<semver>-<platform>` by semver, then by full name.
function compareExtNames(a, b) {
  const ver = (n) => (n.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  const [a1, a2, a3] = ver(a), [b1, b2, b3] = ver(b);
  return a1 - b1 || a2 - b2 || a3 - b3 || a.localeCompare(b);
}

// --- file helpers -----------------------------------------------------------

function filePath(dir, file) { return join(dir, FILES[file]); }
function isPatched(content) { return content.includes(MARK); }

function readFiles(dir) {
  const out = {};
  for (const file of Object.keys(FILES)) {
    const p = filePath(dir, file);
    if (!existsSync(p)) throw new Error(`missing bundle file: ${p}`);
    out[file] = readFileSync(p, 'utf8');
  }
  return out;
}

// --- verify -----------------------------------------------------------------

// Check every anchor (splice + verify-only) against `content` per file. Returns
// { ok, results:[{id,file,got,want,pass}] }. Used standalone (verify command) and
// as apply()'s pre-flight.
export function verifyContent(contents) {
  const results = [];
  for (const spec of [...STEPS, ...VERIFY_ONLY]) {
    if (spec.kind === 'prepend') continue; // prepends have no anchor
    const got = countMatches(contents[spec.file], spec.re);
    results.push({ id: spec.id, file: spec.file, got, want: spec.count, pass: got === spec.count });
  }
  return { ok: results.every((r) => r.pass), results };
}

export function verify(dir) { return verifyContent(readFiles(dir)); }

// --- transform (pure) -------------------------------------------------------

// Produce the patched content for one file from its pristine content. Throws if any
// replace anchor does not match its expected count (never writes a partial splice).
export function patchOne(file, pristine) {
  let out = pristine;
  for (const step of stepsFor(file).filter((s) => s.kind === 'replace')) {
    const got = countMatches(out, step.re);
    if (got !== step.count) {
      throw new Error(`anchor [${step.id}] matched ${got}× (expected ${step.count}) in ${file}`);
    }
    out = out.replace(step.re, step.replacement);
  }
  for (const step of stepsFor(file).filter((s) => s.kind === 'prepend')) {
    out = step.payload + out;
  }
  return out;
}

// --- status -----------------------------------------------------------------

export function status(dir) {
  const files = {};
  for (const file of Object.keys(FILES)) {
    const p = filePath(dir, file);
    const exists = existsSync(p);
    const content = exists ? readFileSync(p, 'utf8') : '';
    files[file] = {
      exists,
      patched: exists && isPatched(content),
      backup: existsSync(p + '.cdbak'),
    };
  }
  const statePath = join(dir, STATE_FILE);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const anyPatched = Object.values(files).some((f) => f.patched);
  const allPatched = Object.values(files).every((f) => f.patched);
  return {
    dir,
    patched: allPatched,
    partial: anyPatched && !allPatched,
    files,
    version: state?.version ?? null,
    state,
    locked: isLocked(dir),
  };
}

// --- lock -------------------------------------------------------------------

function lockPath(dir) { return join(dir, LOCK_FILE); }

function isLocked(dir) {
  const p = lockPath(dir);
  if (!existsSync(p)) return false;
  try {
    const { ts } = JSON.parse(readFileSync(p, 'utf8'));
    return Date.now() - ts < LOCK_STALE_MS;
  } catch { return false; }
}

function acquireLock(dir) {
  const p = lockPath(dir);
  if (isLocked(dir)) {
    const { pid } = JSON.parse(readFileSync(p, 'utf8'));
    throw new Error(`patch in progress (lock held by pid ${pid}); retry shortly`);
  }
  writeFileSync(p, JSON.stringify({ pid: process.pid, ts: Date.now() }));
}

function releaseLock(dir) { try { rmSync(lockPath(dir), { force: true }); } catch { /* ignore */ } }

// --- node --check gate ------------------------------------------------------

// Stage 1 of the canary: does the content PARSE? Throws with the first lines of the
// node error on failure. Exported so it can be exercised directly.
export function checkSyntax(label, content) {
  const tmp = join(tmpdir(), `cd-check-${process.pid}-${label.replace(/\W/g, '_')}.js`);
  try {
    writeFileSync(tmp, content);
    // ELECTRON_RUN_AS_NODE=1 makes process.execPath behave as node when we're running
    // inside VS Code's extension host (where execPath is Code.exe/Electron, not node).
    // Under the plain-node CLI this env var is ignored — so it's correct in both contexts.
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message).toString().split('\n').slice(0, 4).join('\n');
    throw new Error(`node --check failed for ${label}:\n${msg}`);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

// --- apply / revert ---------------------------------------------------------

// Atomically patch both bundles or neither. Returns a summary object.
export function apply(dir, { dryRun = false } = {}) {
  acquireLock(dir);
  try {
    const pristine = readFiles(dir);

    // refuse if anything is already marked (idempotent guard against double-patch)
    for (const [file, content] of Object.entries(pristine)) {
      if (isPatched(content)) throw new Error(`${FILES[file]} already patched (marker present); revert first`);
    }

    // pre-flight: anchor counts must be exact on BOTH files before we touch either
    const v = verifyContent(pristine);
    if (!v.ok) {
      const bad = v.results.filter((r) => !r.pass).map((r) => `${r.id}:${r.got}/${r.want}`).join(', ');
      throw new Error(`anchor verification failed (${bad}); refusing to patch`);
    }

    // build patched content in memory + syntax-gate both
    const patched = {};
    for (const file of Object.keys(FILES)) {
      patched[file] = patchOne(file, pristine[file]);
      checkSyntax(FILES[file], patched[file]);
    }

    if (dryRun) return { dir, dryRun: true, verified: true, wouldPatch: Object.keys(FILES) };

    // backup pristine (guarded: only back up unmarked files), then write atomically
    for (const file of Object.keys(FILES)) backupPristine(dir, file, pristine[file]);
    writeBothAtomic(dir, patched);

    writeFileSync(join(dir, STATE_FILE), JSON.stringify({
      version: PATCH_VERSION,
      patchedAt: new Date().toISOString(),
      hostHash: sha256(patched.host),
      webviewHash: sha256(patched.webview),
      pristineHostHash: sha256(pristine.host),
      pristineWebviewHash: sha256(pristine.webview),
    }, null, 2));

    return { dir, patched: true, version: PATCH_VERSION };
  } finally {
    releaseLock(dir);
  }
}

function backupPristine(dir, file, content) {
  const bak = filePath(dir, file) + '.cdbak';
  if (isPatched(content)) throw new Error(`refusing to back up an already-marked ${FILES[file]}`);
  if (!existsSync(bak)) writeFileSync(bak, content); // keep the first (truly pristine) backup
}

// Stage both files as tmp siblings, then rename both. If the second rename fails,
// restore the first from its .cdbak so we never leave a half-patched pair.
function writeBothAtomic(dir, patched) {
  const files = Object.keys(FILES);
  const staged = files.map((file) => {
    const dst = filePath(dir, file);
    const tmp = dst + '.cdtmp';
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(tmp, patched[file]);
    return { file, dst, tmp };
  });
  const done = [];
  try {
    for (const s of staged) { renameSync(s.tmp, s.dst); done.push(s); }
  } catch (e) {
    for (const s of done) {
      const bak = s.dst + '.cdbak';
      if (existsSync(bak)) { try { writeFileSync(s.dst, readFileSync(bak, 'utf8')); } catch { /* ignore */ } }
    }
    for (const s of staged) { try { rmSync(s.tmp, { force: true }); } catch { /* ignore */ } }
    throw new Error(`atomic write failed (${e.message}); rolled back ${done.length} file(s) from backup`);
  }
  return staged.map((s) => s.file);
}

// Restore both bundles from their .cdbak, verify byte-identity, drop state/lock.
export function revert(dir) {
  acquireLock(dir);
  try {
    const restored = [];
    for (const file of Object.keys(FILES)) {
      const dst = filePath(dir, file);
      const bak = dst + '.cdbak';
      if (!existsSync(bak)) {
        if (!existsSync(dst) || !isPatched(readFileSync(dst, 'utf8'))) continue; // already pristine
        throw new Error(`no backup for ${FILES[file]} but file is patched; cannot revert`);
      }
      const pristine = readFileSync(bak, 'utf8');
      writeFileSync(dst, pristine);
      if (sha256(readFileSync(dst, 'utf8')) !== sha256(pristine)) {
        throw new Error(`revert verification failed for ${FILES[file]}`);
      }
      rmSync(bak, { force: true });
      restored.push(file);
    }
    try { rmSync(join(dir, STATE_FILE), { force: true }); } catch { /* ignore */ }
    return { dir, reverted: restored };
  } finally {
    releaseLock(dir);
  }
}

// Stage 2 of the canary. apply(), then wait for a FRESH host heartbeat (emitted at or
// after we armed) proving the injected code linked at runtime. If none arrives within
// `timeoutMs`, AUTO-REVERT to pristine. The reload that makes the new host emit its
// heartbeat is triggered outside this function (the companion prompts the user, or a
// test supplies `onArmed`); we only arm, wait, and roll back on failure.
//
// Returns { applied, alive, reverted, waitedMs, heartbeat }.
export async function guardedApply(dir, {
  timeoutMs = 10_000,
  hbPath = heartbeatPath(),
  onArmed,               // optional: called after apply, before waiting (reload hook / test seam)
} = {}) {
  const since = Date.now();          // capture BEFORE apply so only a post-arm heartbeat counts
  apply(dir);                        // throws on anchor/syntax failure — nothing written, nothing to revert
  if (onArmed) await onArmed();
  const { alive, heartbeat, waitedMs } = await waitForAlive({ since, timeoutMs, path: hbPath });
  if (!alive) {
    revert(dir);
    return { applied: true, alive: false, reverted: true, waitedMs, heartbeat: null };
  }
  return { applied: true, alive: true, reverted: false, waitedMs, heartbeat };
}
