// File-relay hub for the v4 focus-aware injected bridge (patch/anchors.js). Talks to the
// live bridge in %TEMP%, same interface the actions expect ({sendToTarget, targetState,
// onResult}) so action-logic.js / lcd.js are reused unchanged.
//
// v4 relay protocol (docs/BRIDGE-PROTOCOL.md):
//   - commands  -> claude-deck-cmd-<wid>-<ts>-<seq>.json  (one file per command, written
//     atomically via tmp+rename; the host claims by unlink-first — at-most-once, and two
//     rapid commands can never overwrite each other)
//   - results   <- claude-deck-res-<wid>-<n>.json         (one file per ack; consumed +
//     unlinked here; stale files from a previous run are purged at startup so a dead
//     session's error never replays onto the LCD)
//   - state     <- claude-deck-state-<sessionId>.json     (stamped windowId/focused/active)
//   - liveness  <- claude-deck-alive-<wid>.json           (~2s host stamp; a STALE stamp
//     marks the window dead so its leftover focused:true states can't steer the dials)
//
// Target selection: focused (window has OS focus) AND active (the window's active tab) —
// focus alone is window-level, so with two chats in one window the busiest background
// chat would win the newest-mtime race and the dials would drive the WRONG chat. States
// without the active stamp (pre-v4 bridge) fall back to newest-focused; states with
// neither a live alive-stamp nor recent mtime are ignored entirely.
//
// Effort stays GLOBAL (settings.json) for read AND write: Claude Code exposes no per-chat
// effort control, so the dial is an honest global control. The 'ultracode' rung is
// synthesized from settings xhigh + the focused chat's flag (it is never a settings value).
//
// All fs access is injectable (io) so every branch above is unit-testable in memory.

import * as fsNode from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEffort, defaultSettingsPath, EFFORT_LADDER } from '../../patch/effort.js';

const T = tmpdir();
const LEGACY_RESULT = 'claude-deck-result.json';

const defaultIo = {
  readdir: (d) => fsNode.readdirSync(d),
  read: (p) => fsNode.readFileSync(p, 'utf8'),
  write: (p, d) => fsNode.writeFileSync(p, d),
  rename: (a, b) => fsNode.renameSync(a, b),
  unlink: (p) => fsNode.unlinkSync(p),
  exists: (p) => fsNode.existsSync(p),
  mtime: (p) => fsNode.statSync(p).mtimeMs,
};

export function createRelayHub({
  catalog = [],
  now = () => Date.now(),
  io = defaultIo,
  dir = T,
  readEffortFn = () => readEffort(defaultSettingsPath()),
  aliveMs = 8_000,          // alive stamp older than this = dead window
  bareStateMs = 60_000,     // no alive stamp at all: state file itself must be this fresh
  resultPollMs = 300,
} = {}) {
  const resultListeners = new Set();
  let tsCache = null, tsAt = 0;
  let cmdSeq = 0;
  let lastLegacyResult = 0;

  const atomicWrite = (p, data) => { io.write(p + '.tmp', data); io.rename(p + '.tmp', p); };

  // Purge results left over from a previous plugin/host run — replaying a dead session's
  // last ack painted spurious error/confirm glyphs at startup.
  try {
    for (const f of io.readdir(dir)) {
      if (f.startsWith('claude-deck-res-') && f.endsWith('.json')) { try { io.unlink(join(dir, f)); } catch { /* locked */ } }
    }
    if (io.exists(join(dir, LEGACY_RESULT))) lastLegacyResult = io.mtime(join(dir, LEGACY_RESULT));
  } catch { /* empty dir */ }

  function windowAlive(wid, stateMtime) {
    if (!wid) return false; // v4 states always carry windowId; an id-less state is pre-v2 junk
    try {
      const p = join(dir, `claude-deck-alive-${wid}.json`);
      if (!io.exists(p)) return now() - stateMtime < bareStateMs; // pre-v3 bridge: trust only fresh states
      return now() - io.mtime(p) < aliveMs;
    } catch { return false; }
  }

  function allStates() {
    const out = [];
    try {
      for (const f of io.readdir(dir)) {
        if (f.startsWith('claude-deck-state-') && f.endsWith('.json')) {
          try { const p = join(dir, f); out.push({ mtime: io.mtime(p), s: JSON.parse(io.read(p)) }); } catch { /* torn/locked — skip */ }
        }
      }
    } catch { /* none */ }
    return out;
  }

  // The chat the user is looking at. ACTIVE TAB FIRST: the active flag
  // (mgr.activeSessionId===sid, re-stamped on every tab switch) reliably identifies the
  // tab in view. The focused flag is per-snapshot WINDOW OS-focus and goes STALE — a chat
  // snapped while its window was momentarily unfocused reads focused:false, so filtering on
  // focused first would drop the very tab the user is viewing (the active-Opus-tab shows
  // focused:false while a background Sonnet tab shows focused:true → wrong chat). So filter
  // active first, use focused only to disambiguate multiple windows, then newest mtime.
  function focusedState() {
    const live = allStates().filter((x) => x.s && windowAlive(x.s.windowId, x.mtime));
    if (!live.length) return null;
    const active = live.filter((x) => x.s.active === true);
    const pool = active.length ? active : live;
    const focused = pool.filter((x) => x.s.focused === true);
    return (focused.length ? focused : pool).sort((a, b) => b.mtime - a.mtime)[0].s;
  }

  function targetState() {
    if (tsCache && now() - tsAt < 250) return tsCache; // both dials agree within a tick
    const s = focusedState();
    // Effort DISPLAY is PER-CHAT. Each chat's webview carries its own effortLevel signal
    // (relayed as s.effort) and two chats in one window genuinely show different levels —
    // even though PERSISTENCE is a single global settings.json (writing any chat's effort
    // rewrites that one file; see docs/BRIDGE-PROTOCOL.md). So mirror what the FOCUSED chat
    // shows; fall back to the global settings read only when no live chat carries an effort
    // (sentinel, or a pre-v5 snapshot). 'auto' = absent/unknown, not a ladder rung.
    const VALID = ['low', 'medium', 'high', 'xhigh', 'max'];
    const synthUltra = (v) => (v === 'xhigh' && s && s.ultracode ? 'ultracode' : v);
    // DISPLAY (per-chat, user's choice): the focused chat's own effortLevel signal.
    let raw = s && s.effort != null ? s.effort : null;
    if (raw == null) { try { raw = readEffortFn(); } catch { /* default */ } }
    let effort = synthUltra(VALID.includes(raw) ? raw : 'auto');
    // ANCHOR/WRITE AUTHORITY (round-2 #1): the effort dial must STEP from the real effective
    // effort — the single GLOBAL settings.json value — NEVER the per-chat signal, which is
    // decoupled from effective effort and can be stale. Anchoring the browse on the stale
    // per-chat value would silently write a WRONG global effort. The LCD shows `effort`
    // (per-chat) but action-logic browses/writes from `effortGlobal`.
    let gRaw = null; try { gRaw = readEffortFn(); } catch { /* default */ }
    const effortGlobal = synthUltra(VALID.includes(gRaw) ? gRaw : 'auto');
    // Prefer the LIVE catalog published in the bridge snapshot (claudeConfig.models — the
    // exact vocabulary incl. [1m] variants); the static list is a stale-bridge fallback.
    const liveCat = s && Array.isArray(s.catalog) && s.catalog.length ? s.catalog : catalog;
    tsCache = !s ? { kind: 'no-vscode' } : {
      kind: 'ok', windowId: s.windowId || null, sessionId: s.sessionId || null,
      model: s.modelEffective || s.modelOverride || null,   // the model actually RUNNING (currentMainLoopModel)
      modelResolved: s.modelResolved || null,               // concrete slug for display (resolvedShort)
      modelActive: s.modelActive || null,                   // catalog .value the real model maps to (browse anchor)
      modelOverride: s.modelOverride || null, modelLabel: s.modelLabel || null,
      effort,                                               // per-chat DISPLAY (webview signal)
      effortGlobal,                                         // authoritative global — browse/write anchor
      ultracode: !!s.ultracode,
      summary: s.summary || null, busy: !!s.busy, catalog: liveCat,
    };
    tsAt = now();
    return tsCache;
  }

  // One atomically-written file per command — the host claims each by unlink-first, so
  // nothing is ever overwritten or double-executed. An explicit cmd.windowId/sessionId
  // (captured at browse time) beats focus-at-send-time.
  function sendToTarget(cmd) {
    try {
      const s = cmd.windowId ? null : focusedState();
      const wid = cmd.windowId || (s && s.windowId) || null;
      const sid = cmd.sessionId || (s && s.sessionId) || null;
      if (!wid) return { windowId: null };
      const name = `claude-deck-cmd-${wid}-${String(now()).padStart(14, '0')}-${String(++cmdSeq).padStart(4, '0')}.json`;
      atomicWrite(join(dir, name), JSON.stringify({ op: cmd.op, value: cmd.value, sessionId: sid, id: cmd.id }));
      return { windowId: wid, sessionId: sid };
    } catch { return { windowId: null }; }
  }

  function onResult(cb) { resultListeners.add(cb); return () => resultListeners.delete(cb); }
  function emit(r) { for (const cb of resultListeners) { try { cb(r); } catch { /* listener bug */ } } }

  function pollResults() {
    try {
      const names = io.readdir(dir).filter((f) => f.startsWith('claude-deck-res-') && f.endsWith('.json')).sort();
      for (const f of names) {
        const p = join(dir, f);
        let r = null;
        try { r = JSON.parse(io.read(p)); } catch { /* torn — writes are atomic, so this is junk */ }
        try { io.unlink(p); } catch { continue; } // couldn't claim — retry next poll
        if (r) emit(r);
      }
      // legacy single-slot result.json (pre-v4 host, upgrade window only)
      const lp = join(dir, LEGACY_RESULT);
      if (io.exists(lp)) {
        const m = io.mtime(lp);
        if (m > lastLegacyResult) { lastLegacyResult = m; try { emit(JSON.parse(io.read(lp))); } catch { /* torn */ } }
      }
    } catch { /* dir gone */ }
  }
  // unref'd (#30): the result poller must not pin the event loop open after the Stream Deck
  // socket drops, which is how the plugin used to orphan a node process on every restart.
  const timer = setInterval(pollResults, resultPollMs);
  timer.unref?.();

  return { sendToTarget, targetState, onResult, _pollResults: pollResults, _timer: timer, _stop: () => clearInterval(timer) };
}
