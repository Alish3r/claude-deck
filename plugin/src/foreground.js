// plugin/src/foreground.js — background poller caching the foreground window {pid, isTerminal,
// parents-snapshot}. Runs OFF the press path (a sync probe would freeze the event loop).
// isTerminal = the foreground process name is a known terminal emulator (not "Code"/VS Code).
import { execFile } from 'node:child_process';
import { snapshotParents } from './proctree.js';

const TERMINALS = /windowsterminal|conhost|cmd|powershell|pwsh|wezterm|alacritty|kitty|iterm|terminal|gnome-terminal|konsole|xterm/i;
let cache = { pid: null, isTerminal: false, parents: {} };

// Returns "<pid>\t<processName>" or null. Windows uses a SINGLE-QUOTED Add-Type source (PowerShell
// does not treat \" as an escape); the C# emits "pid`tname".
function rawForeground() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const ps = "Add-Type -Name F -Namespace W -MemberDefinition '[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);';$p=0;[void][W.F]::GetWindowThreadProcessId([W.F]::GetForegroundWindow(),[ref]$p);\"$p`t$((Get-Process -Id $p).ProcessName)\"";
      execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 2000 }, (e, o) => resolve(e ? null : String(o).trim()));
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'tell application "System Events" to get {unix id, name} of first process whose frontmost is true'], { timeout: 1500 }, (e, o) => resolve(e ? null : String(o).trim().replace(/,\s*/, '\t')));
    } else {
      // X11 only (Wayland has no unprivileged active-window API => cache stays null => single-session fallback)
      execFile('sh', ['-c', 'p=$(xdotool getactivewindow getwindowpid 2>/dev/null); [ -n "$p" ] && printf "%s\\t%s" "$p" "$(cat /proc/$p/comm 2>/dev/null)"'], { timeout: 1500 }, (e, o) => resolve(e ? null : String(o).trim()));
    }
  });
}
async function refresh() {
  const [raw, parents] = await Promise.all([rawForeground(), snapshotParents()]);
  if (!raw) { cache = { pid: null, isTerminal: false, parents }; return; }
  const [pidStr, name = ''] = raw.split(/\t/);
  const pid = parseInt(pidStr, 10);
  // isTerminal is the RESOLVED process name against the allowlist — NEVER a blanket per-platform true.
  cache = Number.isFinite(pid) ? { pid, isTerminal: TERMINALS.test(name), parents } : { pid: null, isTerminal: false, parents };
}
let refreshing = false;   // non-overlap guard: skip a tick if the prior refresh is still running
async function refreshGuarded() { if (refreshing) return; refreshing = true; try { await refresh(); } finally { refreshing = false; } }
export function startForegroundPoller({ intervalMs = 1500 } = {}) { refreshGuarded(); return setInterval(refreshGuarded, intervalMs); }
export function foregroundInfo() { return cache; }   // read the cache — synchronous, non-blocking, on the press path
