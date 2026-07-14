// Focus arbitration — decide which (window, session) the dials currently control.
//
// Each VS Code window's host-inject reports focus: {windowId, focused, activeSessionId, ts}.
// Rule (PLAN.md): the OS-focused window wins (latest ts among focused); else the sticky
// last-focused window; else any window with an active session. A short debounce keeps the
// LCD from flapping on rapid focus changes. Pure + clock-injected → fully testable.

export function createArbiter({ debounceMs = 150 } = {}) {
  const windows = new Map();      // windowId -> { focused, activeSessionId, ts }
  let sticky = null;              // last window observed focused
  let rawKey = null, rawSince = 0, committed = null;

  function ingestFocus({ windowId, focused, activeSessionId, ts }) {
    windows.set(windowId, { focused: !!focused, activeSessionId: activeSessionId ?? null, ts: ts ?? 0 });
    if (focused) sticky = windowId;
  }

  function removeWindow(windowId) {
    windows.delete(windowId);
    if (sticky === windowId) sticky = null;
  }

  // Raw (instant) target, no debounce.
  function rawTarget() {
    let best = null;
    for (const [wid, w] of windows) {
      if (w.focused && (!best || w.ts > best.ts)) best = { wid, ...w };
    }
    if (best) return { windowId: best.wid, sessionId: best.activeSessionId };
    if (sticky && windows.has(sticky)) {
      return { windowId: sticky, sessionId: windows.get(sticky).activeSessionId };
    }
    for (const [wid, w] of windows) if (w.activeSessionId) return { windowId: wid, sessionId: w.activeSessionId };
    return null;
  }

  const keyOf = (t) => (t ? `${t.windowId}:${t.sessionId}` : null);

  // Debounced target: a new raw target must hold for `debounceMs` before it commits.
  // The first target commits immediately (no empty-LCD gap).
  function target(now = 0) {
    const t = rawTarget();
    const k = keyOf(t);
    if (k !== rawKey) { rawKey = k; rawSince = now; }
    if (committed === null || (now - rawSince) >= debounceMs) committed = t;
    return committed;
  }

  return { ingestFocus, removeWindow, rawTarget, target, _windows: windows };
}
