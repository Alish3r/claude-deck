// plugin/src/proctree.js — process-tree ancestry. isDescendant(pid, ancestor, parentOf) walks
// pid's ppid chain to see if `ancestor` is above it. parentOf is a {pid:ppid} snapshot from the
// OS (async, cached — never on the press hot path). Guards cycles + depth.
export function isDescendant(pid, ancestor, parentOf) {
  let cur = parentOf[pid], depth = 0;
  const seen = new Set([pid]);
  while (cur != null && cur !== 0 && depth++ < 64) {
    if (cur === ancestor) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = parentOf[cur];
  }
  return false;
}

import { execFile } from 'node:child_process';
// snapshotParents() -> Promise<{pid:ppid}>. Best-effort; returns {} on failure. `wmic` is removed
// on Windows 11 24H2+, so Windows uses CIM/PowerShell.
export function snapshotParents() {
  return new Promise((resolve) => {
    const done = (map) => resolve(map || {});
    if (process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { timeout: 2500 }, (e, out) => {
        if (e) return done({});
        let arr; try { arr = JSON.parse(out); } catch { return done({}); }
        const map = {};
        for (const p of (Array.isArray(arr) ? arr : [arr])) { if (p && p.ProcessId) map[p.ProcessId] = p.ParentProcessId; }
        done(map);
      });
    } else {
      execFile('ps', ['-axo', 'pid=,ppid='], { timeout: 1500 }, (e, out) => {
        if (e) return done({});
        const map = {};
        for (const line of String(out).trim().split(/\r?\n/)) { const m = line.trim().match(/^(\d+)\s+(\d+)/); if (m) map[+m[1]] = +m[2]; }
        done(map);
      });
    }
  });
}
