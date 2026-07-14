// launcher/src/resolve-claude.js — resolve the REAL claude executable. On Windows `claude` is a
// `.cmd`/`.ps1` shim and pty.spawn('claude') may not honor PATHEXT — resolve the concrete path.
import { execFileSync } from 'node:child_process';
export function resolveClaude({ env = process.env, which } = {}) {
  if (env.CLAUDE_DECK_CLAUDE_BIN) return env.CLAUDE_DECK_CLAUDE_BIN;
  const look = which || ((name) => {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      return execFileSync(cmd, [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null;
    } catch { return null; }
  });
  return look('claude') || 'claude';
}
