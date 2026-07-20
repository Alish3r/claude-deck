// plugin/src/cli-hub.js — the plugin's view of claude-deck launcher sessions. Reads markers
// (liveness = fresh alive stamp AND pid alive), writes atomic compact commands, polls+purges
// results. Mirrors relay-hub discipline incl. the startup res-purge (relay-hub.js:63-70). fs injected.
import * as fsNode from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const defaultIo = {
  readdir: (d) => fsNode.readdirSync(d), read: (p) => fsNode.readFileSync(p, 'utf8'),
  write: (p, d) => fsNode.writeFileSync(p, d), rename: (a, b) => fsNode.renameSync(a, b),
  unlink: (p) => fsNode.unlinkSync(p), exists: (p) => fsNode.existsSync(p), mtime: (p) => fsNode.statSync(p).mtimeMs,
};
const defaultPidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function createCliHub({ dir = tmpdir(), io = defaultIo, now = () => Date.now(), aliveMs = 8000, resultPollMs = 300, pidAlive = defaultPidAlive } = {}) {
  const listeners = new Set(); let seq = 0;
  const atomic = (name, data) => { const p = join(dir, name); io.write(p + '.tmp', data); io.rename(p + '.tmp', p); };
  // startup purge — a crashed launcher's leftover result must not paint a false error glyph.
  try { for (const f of io.readdir(dir)) if (f.startsWith('claude-deck-cli-res-') && f.endsWith('.json')) { try { io.unlink(join(dir, f)); } catch { /* locked */ } } } catch { /* empty */ }

  function liveMarkers() {
    const out = [];
    let names; try { names = io.readdir(dir); } catch { return out; }
    for (const f of names) {
      if (!f.startsWith('claude-deck-cli-') || !f.endsWith('.json')) continue;
      if (f.includes('-alive-') || f.includes('-cmd-') || f.includes('-res-')) continue;
      let mk; try { mk = JSON.parse(io.read(join(dir, f))); } catch { continue; }
      const ap = join(dir, `claude-deck-cli-alive-${mk.id}.json`);
      let fresh = false; try { fresh = io.exists(ap) && now() - io.mtime(ap) < aliveMs; } catch { fresh = false; }
      if (fresh && mk.pid && pidAlive(mk.pid)) out.push({ ...mk, alive: true });   // stamp fresh AND pid alive
    }
    return out;
  }
  function sendCompact(id) { atomic(`claude-deck-cli-cmd-${id}-${String(now()).padStart(14, '0')}-${String(++seq).padStart(4, '0')}.json`, JSON.stringify({ op: 'compact', id: 'model:cli' })); }
  function onResult(cb) { listeners.add(cb); return () => listeners.delete(cb); }
  function _pollResults() {
    let names; try { names = io.readdir(dir).filter((f) => f.startsWith('claude-deck-cli-res-') && f.endsWith('.json')).sort(); } catch { return; }
    for (const f of names) { const p = join(dir, f); let r = null; try { r = JSON.parse(io.read(p)); } catch { /* torn */ } try { io.unlink(p); } catch { continue; } if (r) for (const cb of listeners) cb(r); }
  }
  // unref'd (#30) — see relay-hub.js: a poller must never keep the process alive alone.
  const timer = setInterval(_pollResults, resultPollMs);
  timer.unref?.();
  return { liveMarkers, sendCompact, onResult, _pollResults, _timer: timer, _stop: () => clearInterval(timer) };
}
