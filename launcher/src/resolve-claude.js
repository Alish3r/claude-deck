// launcher/src/resolve-claude.js — resolve the REAL claude executable. On Windows `claude` is a
// `.cmd`/`.ps1` shim and pty.spawn('claude') may not honor PATHEXT — resolve the concrete path.
import { execFileSync } from 'node:child_process';

// From `where`/`which` output lines, pick the entry CreateProcess/ConPTY can actually launch. The
// bug this fixes: `where claude` lists the EXTENSIONLESS npm shell shim (a bash script, error 193
// under ConPTY) BEFORE claude.cmd — so taking line[0] crashes the launcher on startup. On Windows
// prefer a real Win32-launchable extension (.cmd/.exe/.bat); elsewhere the first line is correct.
export function pickExecutable(lines, platform = process.platform) {
  const clean = (lines || []).map((s) => s.trim()).filter(Boolean);
  if (!clean.length) return null;
  if (platform === 'win32') return clean.find((l) => /\.(cmd|exe|bat)$/i.test(l)) || clean[0];
  return clean[0];
}

export function resolveClaude({ env = process.env, which } = {}) {
  if (env.CLAUDE_DECK_CLAUDE_BIN) return env.CLAUDE_DECK_CLAUDE_BIN;
  const look = which || ((name) => {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const out = execFileSync(cmd, [name], { encoding: 'utf8' });
      return pickExecutable(out.split(/\r?\n/));
    } catch { return null; }
  });
  return look('claude') || 'claude';
}
