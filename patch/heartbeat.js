// Runtime alive-heartbeat contract + freshness-checked watchdog.
//
// The patched host emits a heartbeat file on load (mgr-ctor splice):
//   <tmpdir>/claude-deck-host-alive.json  ->  {"via":"mgr-ctor","t":<epoch-ms>}
// A static `node --check` proves the bundle PARSES; only a fresh heartbeat proves the
// injected code actually LINKED and ran (catches "manager is undefined" from a
// mis-bound anchor — see docs/BRIDGE-PROTOCOL.md). "Fresh" = emitted at or after the
// moment we armed the watchdog, so a stale heartbeat from a previous session (the file
// persists in tmpdir) can never falsely pass.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const HEARTBEAT_FILE = 'claude-deck-host-alive.json';

export function heartbeatPath(dir = tmpdir()) {
  return join(dir, HEARTBEAT_FILE);
}

// Return the parsed heartbeat ({via, t}) or null if absent/malformed.
export function readHeartbeat(path = heartbeatPath()) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return typeof j?.t === 'number' ? j : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until a heartbeat with t >= `since` appears, or `timeoutMs` elapses.
// Returns { alive, heartbeat, waitedMs }.
export async function waitForAlive({
  since,
  timeoutMs = 10_000,
  intervalMs = 250,
  path = heartbeatPath(),
} = {}) {
  if (typeof since !== 'number') throw new Error('waitForAlive requires a numeric `since`');
  const start = Date.now();
  for (;;) {
    const hb = readHeartbeat(path);
    if (hb && hb.t >= since) return { alive: true, heartbeat: hb, waitedMs: Date.now() - start };
    if (Date.now() - start >= timeoutMs) return { alive: false, heartbeat: hb, waitedMs: Date.now() - start };
    await sleep(intervalMs);
  }
}
