// plugin/src/foreground.js — background poller caching the foreground window {pid, isTerminal,
// parents-snapshot}. Runs OFF the press path (a sync probe would freeze the event loop).
// isTerminal = the foreground process name is a known terminal emulator (not "Code"/VS Code).
//
// #28: the Windows reading no longer spawns a PowerShell per tick. It goes over ONE persistent
// co-process (win-foreground.js) that answers in ~1ms instead of ~674ms. macOS (osascript)
// and Linux (xdotool) keep the per-tick spawn — they have no co-process equivalent, and the
// spawn cost that motivated #28 is a PowerShell-specific problem.
//
// WHAT #28 DID NOT FIX — read this before quoting a latency number. A refresh awaits BOTH
// rawForeground() and snapshotParents(), and snapshotParents (proctree.js) still spawns its own
// PowerShell per tick for the CIM process-table query: measured 1198-1465ms, mean 1368ms, for
// 744 processes. So the refresh's WALL CLOCK is still ~1.4s, gated by proctree, and the
// non-overlap guard below skips ticks while it runs. #28's win is CPU/duty-cycle (one fewer
// process creation per tick, and 674ms of PowerShell work replaced by ~1ms), NOT focus-tracking
// latency, which is unchanged. Moving the parents snapshot onto the same co-process is the
// remaining half of this consolidation — tracked in #33.
import { execFile } from 'node:child_process';
import { snapshotParents } from './proctree.js';
import { createForegroundProbe } from './win-foreground.js';

const TERMINALS = /windowsterminal|conhost|cmd|powershell|pwsh|wezterm|alacritty|kitty|iterm|terminal|gnome-terminal|konsole|xterm/i;
let cache = { pid: null, isTerminal: false, parents: {} };

let probe = null;             // the Windows co-process, or null off Windows / before start()
let getParents = snapshotParents;

// Returns "<pid>\t<processName>" or null.
// On Windows this is one round-trip on the persistent co-process; the co-process emits exactly
// the string the old inline PowerShell did, so the parsing and isTerminal test below are
// unchanged. A dead or slow co-process resolves null, same as an execFile error did.
function rawForeground() {
  if (probe) return probe.read();
  if (process.platform === 'win32') return Promise.resolve(null);   // start() not called yet
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'tell application "System Events" to get {unix id, name} of first process whose frontmost is true'], { timeout: 1500 }, (e, o) => resolve(e ? null : String(o).trim().replace(/,\s*/, '\t')));
    } else {
      // X11 only (Wayland has no unprivileged active-window API => cache stays null => single-session fallback)
      execFile('sh', ['-c', 'p=$(xdotool getactivewindow getwindowpid 2>/dev/null); [ -n "$p" ] && printf "%s\\t%s" "$p" "$(cat /proc/$p/comm 2>/dev/null)"'], { timeout: 1500 }, (e, o) => resolve(e ? null : String(o).trim()));
    }
  });
}
async function refresh() {
  const [raw, parents] = await Promise.all([rawForeground(), getParents()]);
  if (!raw) { cache = { pid: null, isTerminal: false, parents }; return; }
  const [pidStr, name = ''] = raw.split(/\t/);
  const pid = parseInt(pidStr, 10);
  // isTerminal is the RESOLVED process name against the allowlist — NEVER a blanket per-platform true.
  cache = Number.isFinite(pid) ? { pid, isTerminal: TERMINALS.test(name), parents } : { pid: null, isTerminal: false, parents };
}
let refreshing = false;   // non-overlap guard: skip a tick if the prior refresh is still running
async function refreshGuarded() { if (refreshing) return; refreshing = true; try { await refresh(); } finally { refreshing = false; } }

let pollTimer = null;
// unref'd (#30): a background cache must never be the handle that keeps the plugin process
// alive after the Stream Deck socket drops. Returned so the caller can clear it on shutdown.
//
// `spawnFn`, `platform` and `snapshot` are optional injection seams for the unit tests
// (win-foreground.test.js) — production callers pass nothing but intervalMs, so the public
// signature is unchanged.
export function startForegroundPoller({ intervalMs = 1500, logger = null, spawnFn, platform = process.platform, snapshot } = {}) {
  if (snapshot) getParents = snapshot;
  // The probe is inert off Windows (its own platform guard), so foreground.js falls through to
  // the osascript/xdotool branch there. Only wire it up when it can actually serve a reading.
  //
  // `logger` is forwarded so the co-process's respawn/timeout/orphan diagnostics are not dead
  // code: a silently thrashing PowerShell shows up to the user only as dial presses routing to
  // the bridge instead of the focused CLI, which is undiagnosable without these lines.
  if (!probe && platform === 'win32') {
    probe = createForegroundProbe(spawnFn ? { spawnFn, platform, logger } : { platform, logger });
    probe.start();
  }
  refreshGuarded();
  // Idempotent: a second call must not orphan the first interval beyond stopForegroundPoller()'s
  // reach. Production calls this once (plugin.js), so this is hardening.
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshGuarded, intervalMs);
  pollTimer.unref?.();
  return pollTimer;
}

// #30: registered as a shutdown CLOSER (the interval alone is an addTimer). Without this the
// co-process is exactly the orphan that shutdown.js exists to prevent — worse than the old
// execFile, which at least died on its own 2s timeout.
export function stopForegroundPoller() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (probe) { probe.stop(); probe = null; }
  getParents = snapshotParents;
  // A stopped poller must not leave a stale reading readable: the cache is a claim about what
  // is focused RIGHT NOW, and nothing is refreshing it any more.
  cache = { pid: null, isTerminal: false, parents: {} };
}

export function foregroundInfo() { return cache; }   // read the cache — synchronous, non-blocking, on the press path
