// plugin/src/winlang.js — the ONLY I/O in the language-cycle feature (#27).
//
// Owns a single long-lived PowerShell that serves BOTH the 1500ms poll and press-time writes
// over one stdin loop. Measured on the dev machine: spawning PowerShell per call costs ~365ms
// (min 355 / max 372, n=5) — enough to type a third of a second of wrong-language characters
// after a press. The persistent loop is ~0-1ms per command (min 0 / median 0 / max 33, n=8).
//
// Deliberately does NOT touch foreground.js, which still spawns per tick. Consolidating them
// is issue #28 — kept separate so shipped dial behaviour carries zero regression risk here.
//
// ExecutionPolicy on the dev machine is Restricted, so a .ps1 file cannot be loaded; the
// script is passed with -EncodedCommand. Plain `-Command -` is NOT usable: it would consume
// the stdin this command loop needs.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseStateLine, normalizeHkl } from './lang-logic.js';

// WM_INPUTLANGCHANGEREQUEST. Posted (not sent) to the foreground window, which is the
// documented way to change input language — NOT simulated keystrokes (docs/PLAN.md:39).
const WM_INPUTLANGCHANGEREQUEST = 0x0050;

// WIRE PROTOCOL. Every command carries a monotonic id which the reply echoes:
//   get <id>            -> <id>|<currentHkl>|<hkl,hkl,...>|<hwnd>
//   set <id> <hkl>      -> <id>|POSTED=<True|False>
//   preload <id>        -> <id>|<klid,klid,...>
//   (any error)         -> <id>|ERR
// The id is NOT decoration. Without it, a command that times out leaves its reply in flight;
// that orphan is then handed to the NEXT command's resolver and every subsequent reply is
// off by one — a `get` answered by `POSTED=True` makes parseStateLine return null, poll()
// silently no-ops, and the key face latches stale state permanently with no recovery.
// Reproduced during the plan audit by lowering the timeout to 3ms.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Name P -Namespace W -MemberDefinition @'
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);
[DllImport("user32.dll")]public static extern IntPtr GetKeyboardLayout(int t);
[DllImport("user32.dll")]public static extern int GetKeyboardLayoutList(int n,[Out] IntPtr[] l);
[DllImport("user32.dll")]public static extern bool PostMessageW(IntPtr h,uint m,IntPtr w,IntPtr l);
'@
[Console]::Out.WriteLine("READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  $parts = $line.Split(' ')
  $verb = $parts[0]
  $id = $parts[1]
  try {
    $p = 0
    $hwnd = [W.P]::GetForegroundWindow()
    $t = [W.P]::GetWindowThreadProcessId($hwnd, [ref]$p)
    if ($verb -eq 'get') {
      $a = New-Object IntPtr[] 16
      $n = [W.P]::GetKeyboardLayoutList(16, $a)
      $list = if ($n -gt 0) { (0..($n-1) | ForEach-Object { '{0:X8}' -f $a[$_].ToInt64() }) -join ',' } else { '' }
      [Console]::Out.WriteLine(('{0}|{1:X8}|{2}|{3}' -f $id, [W.P]::GetKeyboardLayout($t).ToInt64(), $list, $hwnd.ToInt64()))
    } elseif ($verb -eq 'set') {
      $hkl = [IntPtr]::new([Convert]::ToInt64($parts[2], 16))
      $r = [W.P]::PostMessageW($hwnd, ${WM_INPUTLANGCHANGEREQUEST}, [IntPtr]::Zero, $hkl)
      [Console]::Out.WriteLine(('{0}|POSTED={1}' -f $id, $r))
    } elseif ($verb -eq 'preload') {
      $pre = (Get-ItemProperty 'HKCU:\\Keyboard Layout\\Preload' -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -match '^[0-9]+$' } | Sort-Object { [int]$_.Name } | ForEach-Object { $_.Value }
      [Console]::Out.WriteLine(('{0}|{1}' -f $id, ($pre -join ',')))
    } else {
      [Console]::Out.WriteLine(('{0}|ERR' -f $id))
    }
  } catch {
    # One Win32 error must NOT kill the loop. With $ErrorActionPreference='Stop' and no catch,
    # a single malformed arg terminates the co-process, costing a 355ms respawn and hanging
    # the in-flight caller for the full timeout.
    [Console]::Out.WriteLine(('{0}|ERR' -f $id))
  }
}`;

// `spawnFn` and `platform` are injectable so Task 3b can unit-test the state machine (timeout,
// orphan reply, mid-command death, concurrent setLayout) with a fake process and no PowerShell.
export function createWinLang({ intervalMs = 1500, logger = null, spawnFn = spawn, platform = process.platform } = {}) {
  const log = (m) => { try { logger && logger.error(`[winlang] ${m}`); } catch { /* pre-connect */ } };

  // Non-Windows has no PowerShell and no equivalent API. foreground.js branches per platform
  // (foreground.js:14-22); here the honest answer is an inert stub. WITHOUT this guard, spawn
  // fails -> 'exit' fires -> scheduleRespawn loops forever on any Mac/Linux dev machine, and
  // it survives `node --test`.
  if (platform !== 'win32') {
    log('non-Windows platform — language key inert');
    return {
      start() {}, stop() {},
      getState: () => ({ hkl: null, list: [], hwnd: null, alive: false }),
      getPreload: () => [],
      onChange() { return () => {}; },
      async setLayout() { return { ok: false, confirmed: null, reason: 'unsupported-platform' }; },
    };
  }

  let ps = null, rl = null, ready = false, timer = null, stopped = false;
  let gen = 0;                              // generation: a superseded process's events are ignored
  let backoff = 500;
  let nextId = 1;
  let pending = null;                       // { id, resolve } — at most one in flight
  let polling = false;
  let state = { hkl: null, list: [], hwnd: null, alive: false };
  let preload = [];
  const listeners = new Set();

  const emit = () => { for (const fn of listeners) { try { fn(state); } catch { /* listener owns its errors */ } } };

  function spawnPs() {
    if (stopped) return;
    const myGen = ++gen;
    const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    try {
      ps = spawnFn('powershell', ['-NoProfile', '-NoLogo', '-EncodedCommand', enc], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { log(`spawn failed: ${e.message}`); return scheduleRespawn(); }
    const myPs = ps;

    myPs.on('exit', (code) => {
      if (myGen !== gen) return;            // a stop()/respawn already superseded this process
      log(`co-process exited (code=${code}) — respawning`);
      ready = false;
      try { rl && rl.close(); } catch { /* already closed */ }
      rl = null;
      // Settle any in-flight caller immediately. Leaving it pending hangs setLayout for the
      // full 2000ms timeout and lets the DEAD process's resolver be reused by the new one.
      if (pending) { const p = pending; pending = null; p.resolve(null); }
      state = { ...state, alive: false };
      emit();
      scheduleRespawn();
    });
    myPs.on('error', (e) => log(`process error: ${e.message}`));
    // PowerShell writes CLIXML progress noise to stderr; only log real content.
    myPs.stderr.on('data', (d) => { const s = String(d).trim(); if (s && !s.startsWith('#< CLIXML') && !s.startsWith('<Objs')) log(`stderr: ${s.slice(0, 200)}`); });

    rl = createInterface({ input: myPs.stdout });
    rl.on('line', (raw) => {
      if (myGen !== gen) return;            // late line from a superseded process
      const line = raw.trim();
      if (!ready) {
        // Read Preload, then take one immediate reading. Chaining here (rather than polling for
        // readiness from start()) means exactly ONE extra `get`, issued once, already inside the
        // mutex — no interval to leak and nothing for a user's first press to queue behind
        // indefinitely.
        if (line === 'READY') { ready = true; backoff = 500; log('ready'); state = { ...state, alive: true }; void loadPreload().then(() => poll()); }
        return;
      }
      const bar = line.indexOf('|');
      if (bar < 0) return;
      const id = Number(line.slice(0, bar));
      // Orphan discard — the fix for the permanent request/reply skew. A reply whose id does
      // not match the in-flight command belongs to a command that already timed out.
      if (!pending || id !== pending.id) { log(`dropped orphan reply id=${id}`); return; }
      const p = pending; pending = null;
      p.resolve(line.slice(bar + 1));
    });
  }

  let respawnTimer = null;
  function scheduleRespawn() {
    if (stopped) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 30_000);   // cap so a permanently broken PowerShell stops hammering
    log(`respawn in ${wait}ms`);
    // The handle is retained so stop() can CANCEL it. Checking `stopped` inside the callback is
    // not enough: start() resets stopped=false, so an orphan timer from before a stop/start
    // still fires and spawns a THIRD process whose handle overwrites `ps` and is never killed.
    // Reachable in ~500ms via the lazy key-remove/key-re-add lifecycle.
    respawnTimer = setTimeout(() => { respawnTimer = null; if (!stopped) spawnPs(); }, wait);
    if (respawnTimer.unref) respawnTimer.unref();
  }

  // Writes one command and resolves with its PAYLOAD (the text after `<id>|`), or null on
  // timeout / dead co-process. Callers must hold the transaction mutex.
  // Distinguishes "co-process is gone" from "co-process is alive but slow" so the caller can
  // report an honest reason instead of labelling every failure 'no-coprocess'.
  let lastSendFailure = null;
  function rawSend(verb, arg = '', timeoutMs = 2000) {
    return new Promise((resolve) => {
      if (!ready || !ps) { lastSendFailure = 'no-coprocess'; return resolve(null); }
      const id = nextId++;
      const t = setTimeout(() => {
        if (pending && pending.id === id) { pending = null; lastSendFailure = 'timeout'; log(`timeout: ${verb} id=${id}`); resolve(null); }
      }, timeoutMs);
      pending = { id, resolve: (payload) => { clearTimeout(t); resolve(payload); } };
      try { ps.stdin.write(arg ? `${verb} ${id} ${arg}\n` : `${verb} ${id}\n`); }
      catch (e) { clearTimeout(t); pending = null; log(`write failed: ${e.message}`); resolve(null); }
    });
  }

  // ONE mutex for whole TRANSACTIONS, not individual sends. setLayout is post -> settle ->
  // read-back; serializing only the sends let a second press's post land inside the first's
  // settle window, so the first read back the second's result and reported {ok:false} on a
  // switch that actually worked — a false warn dot, violating the honesty locked decision.
  // Reproduced during the plan audit.
  let chain = Promise.resolve();
  function txn(fn) {
    const next = chain.then(fn, fn);
    chain = next.then(() => {}, () => {});   // never let a rejection poison the chain
    return next;
  }

  // Holds the transaction mutex (it must — replies are paired one-at-a-time), so it uses a
  // SHORT timeout: this is a local registry read that answers in ~1ms, and the mutex is what
  // the first press queues behind. With the default 2000ms a hung registry read would stall
  // the first press for two seconds after every spawn/respawn.
  async function loadPreload() {
    const payload = await txn(() => rawSend('preload', '', 300));
    if (payload === null || payload === 'ERR') { log('preload read failed — falling back to numeric order'); return; }
    preload = payload.split(',').map((s) => normalizeHkl(s.trim())).filter(Boolean);
  }

  // Does the actual read. NOT wrapped in txn — callers wrap, so nesting can't deadlock.
  async function readState() {
    const payload = await rawSend('get');
    const parsed = payload ? parseStateLine(payload) : null;
    if (!parsed) return false;
    const changed = parsed.hkl !== state.hkl
      || parsed.list.join(',') !== state.list.join(',')
      || parsed.hwnd !== state.hwnd;
    state = { ...parsed, alive: true };
    if (changed) emit();
    return true;
  }

  async function poll() {
    if (polling) return false;               // non-overlap guard, mirroring foreground.js:33-34
    polling = true;
    try { return await txn(readState); }
    finally { polling = false; }
  }

  return {
    start() {
      if (ps || timer) return;
      stopped = false;
      spawnPs();
      timer = setInterval(() => { void poll(); }, intervalMs);
      if (timer.unref) timer.unref();
      // The first reading is NOT scheduled here — it is chained off READY in the readline
      // handler above. Polling from start() to wait for readiness would leak an interval that
      // stop() cannot clear, and would queue a `get` the user's first press has to wait on.
    },
    stop() {
      stopped = true;
      gen++;                                 // invalidate live handlers BEFORE killing
      if (timer) { clearInterval(timer); timer = null; }
      if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
      if (pending) { const p = pending; pending = null; p.resolve(null); }
      try { rl && rl.close(); } catch { /* already closed */ }
      rl = null;
      try { ps && ps.stdin.write('quit\n'); } catch { /* already dead */ }
      try { ps && ps.kill(); } catch { /* already dead */ }
      ps = null; ready = false;
      // MUST mirror the exit handler. langFace() keys off `alive` to decide between the
      // `starting` placeholder and a language label, so leaving it true after stop() makes a
      // dead co-process render a stale language — the exact illusion the locked decision bans.
      state = { ...state, alive: false };
      emit();
    },
    getState: () => state,
    getPreload: () => preload,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // Returns the CONFIRMED layout read back from Windows — never the requested value. Two
    // things make a post fail silently: UIPI blocking the message into an elevated window, and
    // a window legitimately declining it by not calling DefWindowProc (documented behaviour of
    // WM_INPUTLANGCHANGEREQUEST). Both are caught by the read-back, which is why it is load-
    // bearing rather than belt-and-braces.
    async setLayout(hkl) {
      const target = normalizeHkl(hkl);
      if (!target) return { ok: false, confirmed: state.hkl, reason: 'bad-hkl' };
      return txn(async () => {
        lastSendFailure = null;
        const posted = await rawSend('set', target);
        if (posted === null || posted === 'ERR') return { ok: false, confirmed: state.hkl, reason: lastSendFailure ?? 'no-coprocess' };
        // The target app processes the posted message asynchronously; give it a beat before
        // reading back. 120ms was ample in the verification probe (which used 250ms).
        await new Promise((r) => setTimeout(r, 120));
        const read = await readState();
        // Never claim ok from cached state: if the read-back did not actually happen we do not
        // know the layout, and saying ok would break the project's closed-loop rule.
        if (!read) return { ok: false, confirmed: null, reason: 'stale' };
        const confirmed = state.hkl;
        const ok = confirmed === target;
        log(`setLayout req=${target} confirmed=${confirmed} ok=${ok}`);
        return { ok, confirmed, reason: ok ? null : 'not-applied' };
      });
    },
  };
}
