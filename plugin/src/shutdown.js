// plugin/src/shutdown.js — process lifecycle for the Stream Deck plugin (#30).
//
// WHY THIS EXISTS: when Stream Deck restarts the plugin (or the app quits), the websocket
// drops but the node process kept running — every restart left a zombie holding the
// bundle's sharp DLLs (blocking the next deploy with EPIPE) and a second instance
// contending for the plugin's resources.
//
// NO SDK DISCONNECT EVENT EXISTS. @elgato/streamdeck 2.1.0's Connection only wires
// `webSocket.onmessage` and `webSocket.onopen` (dist/plugin/connection.js) — no `onclose`,
// no `onerror` — and its event map adds exactly one event beyond the protocol's:
//
//   type ExtendedEventMap = PluginEventMap & { connected: [info: RegistrationInfo] };
//
// The `connection` singleton is not re-exported from the package entry (index.d.ts exports
// only actions/devices/event types/UIController/streamDeck), and package.json pins
// `"exports": "./dist/plugin/index.js"`, so deep-importing it is not supported either.
// The only signal a dropped socket gives us is `ws` emitting an unhandled socket error,
// which surfaces as `uncaughtException: Error: read ECONNRESET`.
//
// So the strategy is two independent layers:
//   1. Exit on CONNECTION-LOSS errors only (below). A blanket exit-on-uncaughtException
//      would turn any ordinary bug into a silent Stream Deck restart loop — precisely the
//      failure mode bootstrap.js's crash log exists to diagnose.
//   2. Belt and braces: every long-lived interval is unref'd, so on a CLEAN socket close
//      (app quit — no error at all) the event loop simply drains and node exits by itself.

// Socket-level codes that mean "the Stream Deck connection is gone". Deliberately narrow:
// this process opens exactly one socket (the SD websocket) — the relay hub is file-based and
// the foreground poller talks to its co-process over pipes, not sockets — so these codes
// cannot plausibly come from anything else. Anything outside this set is left to
// bootstrap.js's crash log.
//
// NOTE (#28): the foreground co-process's stdin pipe CAN raise EPIPE if PowerShell dies at the
// wrong moment, and EPIPE is in the set above — so an escaped one would masquerade as a dropped
// Stream Deck socket and shut the plugin down. A try/catch around the write is NOT what stops
// that (stream errors are emitted asynchronously and cannot be caught that way); the explicit
// `stdin.on('error')` listener in win-foreground.js is. Do not remove it.
const CONNECTION_LOSS = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED'];
const CODE_RE = new RegExp(`\\b(${CONNECTION_LOSS.join('|')})\\b`);

/**
 * True only for errors that mean the Stream Deck websocket died. Checks `.code` (and one
 * level of `.cause`) first; falls back to the message because `ws` surfaces some socket
 * errors as a bare `Error: read ECONNRESET` without a structured code.
 */
export function isConnectionLoss(err) {
  if (err == null) return false;
  const code = err.code ?? (err.cause && err.cause.code);
  if (typeof code === 'string' && CONNECTION_LOSS.includes(code)) return true;
  const msg = typeof err === 'string' ? err : String((err && err.message) || '');
  return CODE_RE.test(msg);
}

/**
 * Ordered teardown: clear timers -> close hubs/servers -> exit. Idempotent (a SIGTERM
 * racing an ECONNRESET must not run it twice) and watchdogged, so a closer that never
 * settles still cannot leave the orphan behind that this whole module exists to prevent.
 *
 * `exit`, `log` and `setTimer` are injected so the whole routine is unit-testable without
 * killing the test runner.
 */
export function createShutdown({
  exit = (code) => process.exit(code),
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  graceMs = 1500,
} = {}) {
  const timers = [];
  const closers = [];
  let running = false;

  return {
    /** Register an interval/timeout: unref'd immediately (layer 2) and cleared on shutdown. */
    addTimer(timer) {
      if (timer && typeof timer === 'object') timer.unref?.();
      if (timer != null) timers.push(timer);
      return timer;
    },
    /** Register a close function (hub.close(), poller._stop(), …). May return a promise. */
    addCloser(fn) {
      if (typeof fn === 'function') closers.push(fn);
      return fn;
    },
    get started() { return running; },
    get pending() { return { timers: timers.length, closers: closers.length }; },

    async run(reason) {
      if (running) return false;
      running = true;
      log(`shutdown: ${reason}`);

      // 1. timers first — nothing should fire a repaint into a half-closed hub.
      for (const t of timers) { try { clearInterval(t); } catch { /* already gone */ } }
      timers.length = 0;

      // Hard deadline: if a closer hangs we still exit. unref'd so the watchdog itself
      // never becomes the handle that keeps the process alive.
      const watchdog = setTimer(() => { try { exit(0); } catch { /* exiting */ } }, graceMs);
      if (watchdog && typeof watchdog === 'object') watchdog.unref?.();

      // 2. close the hubs / servers.
      for (const fn of closers) {
        try { await fn(); } catch (e) { log(`shutdown closer failed: ${(e && e.message) || e}`); }
      }
      closers.length = 0;
      try { clearTimer(watchdog); } catch { /* fake timer */ }

      // 3. exit.
      exit(0);
      return true;
    },
  };
}

/**
 * Wire the shutdown into process signals + connection-loss errors. Registered IN ADDITION
 * to bootstrap.js's log-only handlers (node runs every listener), so real crashes are
 * still recorded before anything decides whether to exit.
 */
export function installProcessHandlers(shutdown, { proc = process } = {}) {
  const maybeExit = (label) => (err) => {
    if (isConnectionLoss(err)) shutdown.run(`${label} ${(err && err.code) || (err && err.message) || err}`);
    // else: not a dropped socket — leave it to bootstrap.js's crash log. Exiting here
    // would hide ordinary bugs behind an endless Stream Deck restart loop.
  };
  proc.on('uncaughtException', maybeExit('uncaughtException'));
  proc.on('unhandledRejection', maybeExit('unhandledRejection'));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { proc.on(sig, () => shutdown.run(sig)); } catch { /* unsupported on this platform */ }
  }
  return shutdown;
}
