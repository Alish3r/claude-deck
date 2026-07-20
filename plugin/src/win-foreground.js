// plugin/src/win-foreground.js — the persistent PowerShell co-process behind foreground.js's
// Windows branch (#28).
//
// WHY: foreground.js used to `execFile` a fresh PowerShell every 1500ms tick — a permanent
// duty cycle for what is two cheap user32 calls. Measured on the dev machine, old command vs
// this loop back-to-back on the same foreground window (n=5, identical payload every time):
//
//   old execFile: [699, 597, 720, 677, 677] ms   mean 674ms
//   co-process:   [  1,   1,   0,   1,   1] ms   mean 0.8ms   (startup, one-time: 423ms)
//   sustained n=20: min 0 / max 15 / mean 1.15ms
//
// ~800x per read. The 674ms is higher than #28's quoted 365ms because the old command also
// paid the Get-Process cost described under NAME RESOLUTION below, on top of the spawn.
//
// The state machine is a deliberate copy of langdeck/src/winlang.js, which went through a
// 5-reviewer audit that REPRODUCED three concurrency defects. Copied, not imported: the two
// plugins ship independent bundles and langdeck staying free of cross-plugin imports is a
// locked decision. The mechanisms that are load-bearing (do not "simplify" them away):
//   - monotonic wire ids + orphan-reply discard (a single timeout otherwise desyncs
//     request/reply pairing permanently)
//   - a transaction mutex, so replies are only ever paired one at a time
//   - a generation counter, so a superseded process's late events are ignored
//   - the exit handler settling the in-flight `pending`, so a caller never hangs
//   - try/catch INSIDE the PowerShell loop, so one Win32 error costs a reply, not the process
//
// ExecutionPolicy is Restricted on the dev machine, so a .ps1 cannot be loaded; the script goes
// in via -EncodedCommand. Plain `-Command -` is NOT usable — it would consume the stdin this
// command loop reads.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// WIRE PROTOCOL. Every command carries a monotonic id which the reply echoes:
//   fg <id>     -> <id>|<pid>\t<processName>
//   (any error) -> <id>|ERR
//
// The payload is deliberately the SAME "<pid>\t<name>" string the old execFile branch produced,
// so foreground.js's parsing and — critically — its isTerminal allowlist test are byte-for-byte
// unchanged. The NAME must stay identical too: a different name source would silently shift
// which windows count as terminals, and that is dial-targeting behaviour.
//
// NAME RESOLUTION. `(Get-Process -Id $p).ProcessName` was the original source, but it is the
// dominant cost of a reading — .NET's Process class enumerates the whole process table
// (measured on this machine, 739 processes: 67-215ms per call, cmdlet and
// [Diagnostics.Process]::GetProcessById alike). QueryFullProcessImageNameW on a
// PROCESS_QUERY_LIMITED_INFORMATION handle is the same answer for ~0.2ms.
//
// It is NOT a blanket replacement: OpenProcess is refused for protected/other-session
// processes (measured: 152 of 732 refused), so Get-Process REMAINS the fallback. A sweep over
// every process on this machine compared the two: same=580, MISMATCH=0, refused=152. The
// fallback is what keeps the resolved name — and therefore isTerminal — never worse than
// before. ProcessName is the image filename without its extension, which is exactly what
// GetFileNameWithoutExtension of the full image path yields.
//
// CAVEAT on the numbers above: they are the OpenProcess-permitted path. When the foreground
// window belongs to a refused process the fallback runs, and that tick costs ~70-215ms inside
// the single-threaded loop (still far better than the old 674ms, but not ~1ms). Ordinary user
// windows — VS Code, terminals, browsers — are all in the permitted set.
//
// A tab is emitted as [char]9 rather than a PowerShell backtick-t so this JS template literal
// needs no escaping. Process names cannot contain a tab, so the split stays unambiguous.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Name F -Namespace W -MemberDefinition @'
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);
[DllImport("kernel32.dll",SetLastError=true)]public static extern IntPtr OpenProcess(int a,bool inherit,int pid);
[DllImport("kernel32.dll",SetLastError=true)]public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]public static extern bool QueryFullProcessImageNameW(IntPtr h,int flags,System.Text.StringBuilder buf,ref int size);
'@
function Get-FgName($procId) {
  $h = [W.F]::OpenProcess(0x1000, $false, $procId)   # PROCESS_QUERY_LIMITED_INFORMATION
  if ($h -ne [IntPtr]::Zero) {
    try {
      $sb = New-Object System.Text.StringBuilder 1024
      $sz = 1024
      if ([W.F]::QueryFullProcessImageNameW($h, 0, $sb, [ref]$sz)) {
        return [IO.Path]::GetFileNameWithoutExtension($sb.ToString())
      }
    } finally { [void][W.F]::CloseHandle($h) }
  }
  # Refused (protected / other session) — fall back to the original, slower, more privileged
  # source rather than reporting a name we do not have. It throws for a pid that has already
  # exited; the CALLER catches that into an empty name so the pid still survives.
  return (Get-Process -Id $procId).ProcessName
}
[Console]::Out.WriteLine("READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  $parts = $line.Split(' ')
  $id = $parts[1]
  try {
    if ($parts[0] -eq 'fg') {
      $p = 0
      [void][W.F]::GetWindowThreadProcessId([W.F]::GetForegroundWindow(), [ref]$p)
      if ($p -eq 0) {
        # No foreground window this session can see (locked desktop, another session, a focus
        # transition). ERR -> null -> single-session fallback, as the old execFile's non-zero
        # exit did.
        [Console]::Out.WriteLine(('{0}|ERR' -f $id))
      } else {
        # An UNRESOLVABLE name is NOT an unresolvable pid. The old command emitted the bare pid
        # with an empty name when Get-Process lost the race against an exiting process (observed
        # live: old="133200" while the co-process said ERR). Keeping the pid matters — it is what
        # pickCompactRoute matches CLI markers and their descendants against, so discarding it
        # would drop a valid CLI route. An empty name tests false against TERMINALS, which is the
        # same isTerminal the old path produced.
        $n = ''
        try { $n = Get-FgName $p } catch { $n = '' }
        [Console]::Out.WriteLine(('{0}|{1}{2}{3}' -f $id, $p, [char]9, $n))
      }
    } else {
      [Console]::Out.WriteLine(('{0}|ERR' -f $id))
    }
  } catch {
    # One Win32 / vanished-process error must NOT kill the loop. With $ErrorActionPreference
    # = 'Stop' and no catch, a momentarily-gone foreground pid terminates the co-process and
    # costs a ~355ms respawn plus a stalled caller. ERR reads as "no reading this tick", which
    # is exactly what the old execFile error path meant.
    [Console]::Out.WriteLine(('{0}|ERR' -f $id))
  }
}`;

/**
 * A long-lived PowerShell that answers "what window is in front?".
 *
 * `spawnFn` and `platform` are injectable so the state machine is unit-testable with a fake
 * child process and no PowerShell (win-foreground.test.js), on any platform.
 *
 * Returns { start, stop, read, isAlive }. `read()` resolves "<pid>\t<name>" or null — it NEVER
 * rejects, because its only caller is a poll tick whose honest answer to any failure is "no
 * foreground reading", which downstream degrades to the single-session fallback.
 */
export function createForegroundProbe({ logger = null, spawnFn = spawn, platform = process.platform } = {}) {
  const log = (m) => { try { logger && logger.error(`[foreground] ${m}`); } catch { /* pre-connect */ } };

  // Non-Windows has no PowerShell and no equivalent API — foreground.js keeps its own
  // osascript/xdotool spawn path for those. An inert stub here is the honest answer. WITHOUT
  // this guard, spawn fails -> 'exit' fires -> scheduleRespawn loops forever on any Mac/Linux
  // machine, and it would survive `node --test`.
  if (platform !== 'win32') {
    return { start() {}, stop() {}, isAlive: () => false, read: async () => null };
  }

  let ps = null, rl = null, ready = false, stopped = false;
  let gen = 0;                    // generation: a superseded process's events are ignored
  let backoff = 500;
  let nextId = 1;
  let pending = null;             // { id, resolve } — at most one in flight (the mutex enforces it)
  let respawnTimer = null;

  function spawnPs() {
    if (stopped) return;
    const myGen = ++gen;
    const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    try {
      ps = spawnFn('powershell', ['-NoProfile', '-NoLogo', '-EncodedCommand', enc], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { log(`spawn failed: ${e.message}`); ps = null; return scheduleRespawn(); }
    const myPs = ps;

    // UNREF THE CHILD AND ALL THREE PIPES. This is not tidiness — a spawned child with piped
    // stdio is FOUR ref'd libuv handles (ProcessWrap + 3 PipeWrap), and shutdown.js's layer 2
    // (shutdown.js:24-25) depends on every long-lived handle being unref'd so that a CLEAN
    // Stream Deck socket close — which raises no error and sends no signal, so shutdown.run()
    // never fires — lets the event loop drain and node exit by itself. Without this the
    // co-process becomes the one handle that pins the process forever, recreating the exact
    // zombie #30 exists to kill: a node holding the bundle's sharp DLLs, blocking the next
    // deploy with EPIPE, one more per Stream Deck restart.
    // Unref'd pipes still deliver data while the loop is alive for other reasons, so READY and
    // every reply arrive normally.
    myPs.unref?.();
    myPs.stdin?.unref?.();
    myPs.stdout?.unref?.();
    myPs.stderr?.unref?.();
    // `write` on a dead child's stdin is discarded silently on Windows, but the stream can also
    // emit 'error' ASYNCHRONOUSLY, which a try/catch around write() cannot catch. Without this
    // listener that becomes an uncaughtException — and EPIPE is in shutdown.js's CONNECTION_LOSS
    // set, so it would masquerade as a dropped Stream Deck socket and shut the plugin down.
    myPs.stdin?.on?.('error', (e) => log(`stdin error: ${e.message}`));

    myPs.on('exit', (code) => {
      if (myGen !== gen) return;  // a stop()/respawn already superseded this process
      log(`co-process exited (code=${code}) — respawning`);
      ready = false;
      try { rl && rl.close(); } catch { /* already closed */ }
      rl = null;
      // Settle any in-flight caller immediately. Leaving it pending stalls the poll's
      // non-overlap guard for the full timeout AND lets the DEAD process's resolver be
      // reused by the replacement.
      if (pending) { const p = pending; pending = null; p.resolve(null); }
      scheduleRespawn();
    });
    myPs.on('error', (e) => log(`process error: ${e.message}`));
    // PowerShell writes CLIXML progress noise to stderr; only log real content.
    myPs.stderr.on('data', (d) => { const s = String(d).trim(); if (s && !s.startsWith('#< CLIXML') && !s.startsWith('<Objs')) log(`stderr: ${s.slice(0, 200)}`); });

    rl = createInterface({ input: myPs.stdout });
    rl.on('line', (raw) => {
      if (myGen !== gen) return;  // late line from a superseded process
      const line = raw.trim();
      if (!ready) {
        // No command is chained off READY here (unlike winlang, which must load Preload):
        // foreground.js's own interval issues the next `fg` within 1500ms, so there is
        // nothing to prime and no extra interval to leak.
        if (line === 'READY') { ready = true; backoff = 500; log('ready'); }
        return;
      }
      const bar = line.indexOf('|');
      if (bar < 0) return;
      const id = Number(line.slice(0, bar));
      // Orphan discard. A reply whose id does not match the in-flight command belongs to a
      // command that already timed out. Pairing it to the CURRENT command would answer this
      // tick with the previous tick's window and skew every reply after it by one — i.e. the
      // dials would target the previously-focused chat, permanently, with no recovery.
      if (!pending || id !== pending.id) { log(`dropped orphan reply id=${id}`); return; }
      const p = pending; pending = null;
      p.resolve(line.slice(bar + 1));
    });
  }

  function scheduleRespawn() {
    if (stopped) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 30_000);   // cap so a permanently broken PowerShell stops hammering
    log(`respawn in ${wait}ms`);
    // The handle is retained so stop() can CANCEL it. Checking `stopped` inside the callback
    // is not enough: start() resets stopped=false, so an orphan timer from before a stop/start
    // still fires and spawns a SECOND process whose handle overwrites `ps` and is never killed.
    // Clearing before reassigning closes the same hole from the other side: entering here twice
    // without an intervening fire would otherwise LOSE the first handle, putting it beyond
    // stop()'s reach and letting it spawn that orphan anyway.
    if (respawnTimer) clearTimeout(respawnTimer);
    respawnTimer = setTimeout(() => { respawnTimer = null; if (!stopped) spawnPs(); }, wait);
    if (respawnTimer.unref) respawnTimer.unref();
  }

  // Writes one command and resolves with its PAYLOAD (the text after `<id>|`), or null on
  // timeout / dead co-process. Callers must hold the transaction mutex.
  function rawSend(verb, timeoutMs = 2000) {
    return new Promise((resolve) => {
      if (!ready || !ps) return resolve(null);
      const id = nextId++;
      const t = setTimeout(() => {
        if (pending && pending.id === id) { pending = null; log(`timeout: ${verb} id=${id}`); resolve(null); }
      }, timeoutMs);
      // Deliberately NOT unref'd (the child and its pipes are — see spawnPs). With every other
      // handle unref'd this timeout is the only thing keeping an IN-FLIGHT command alive, and
      // unref'ing it lets node drain mid-command: the promise never settles, `refreshing` never
      // clears, and a bare script exits with "unsettled top-level await" (observed). Ref'd, it
      // bounds the loop's extra lifetime to one timeoutMs (2s) after a clean socket close —
      // shorter than shutdown.js's own watchdog — and every read() is guaranteed to settle.
      pending = { id, resolve: (payload) => { clearTimeout(t); resolve(payload); } };
      try { ps.stdin.write(`${verb} ${id}\n`); }
      catch (e) { clearTimeout(t); pending = null; log(`write failed: ${e.message}`); resolve(null); }
    });
  }

  // ONE mutex for whole TRANSACTIONS. There is only one caller today (the poll tick, which
  // additionally has its own non-overlap guard), so this is belt-and-braces — but `pending`
  // holds at most ONE command, so any second concurrent caller would silently clobber the
  // first's resolver. Keeping the mutex makes that structurally impossible.
  let chain = Promise.resolve();
  function txn(fn) {
    const next = chain.then(fn, fn);
    chain = next.then(() => {}, () => {});   // never let a rejection poison the chain
    return next;
  }

  return {
    start() {
      if (ps || respawnTimer) return;   // idempotent
      stopped = false;
      spawnPs();
    },
    stop() {
      stopped = true;
      gen++;                            // invalidate live handlers BEFORE killing
      if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
      if (pending) { const p = pending; pending = null; p.resolve(null); }
      try { rl && rl.close(); } catch { /* already closed */ }
      rl = null;
      try { ps && ps.stdin.write('quit\n'); } catch { /* already dead */ }
      try { ps && ps.kill(); } catch { /* already dead */ }
      ps = null; ready = false;
    },
    isAlive: () => ready,
    async read() {
      const payload = await txn(() => rawSend('fg'));
      // 'ERR' (no foreground window, or the pid vanished between the two calls) and null
      // (dead/slow co-process) both mean the same thing to the caller: no reading this tick.
      return payload === null || payload === 'ERR' ? null : payload;
    },
  };
}
