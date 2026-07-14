// launcher/src/contain.js — ensure the child `claude` cannot outlive the launcher on a normal
// exit/signal. On a HARD-KILL of the launcher, JS cleanup does not run: POSIX relies on the PTY
// master closing => the slave gets SIGHUP => claude exits; Windows has no Job Object here, so a
// hard-kill may briefly orphan claude (reaped by the plugin liveness check). See the plan Open risks.
import { execFile } from 'node:child_process';

export function killTree(childPid) {
  if (!childPid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(childPid), '/T', '/F'], () => {});
  else { try { process.kill(-childPid, 'SIGKILL'); } catch { try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } } }
}

// Fire onOrphan when our parent process dies. process.ppid is a CACHED value (not a live getter —
// proven on-host), so we capture it once and POLL whether that pid is still alive.
export function watchParent(onOrphan, { intervalMs = 2000 } = {}) {
  const parentPid = process.ppid;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  return setInterval(() => { if (!alive(parentPid)) onOrphan(); }, intervalMs);
}
