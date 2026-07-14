// Host bridge logic — the write-side + focus/session source of truth.
//
// The manager-capture splice sets globalThis.__claudeDeck.mgr (the panel manager:
// sessionPanels Map<sessionId,WebviewPanel>, activeSessionId). This factory wires that
// manager to a transport and implements the host's responsibilities:
//   - report focus + active session to the hub
//   - relay webview snapshots/acks to the hub (the host never reads Cf itself)
//   - route claudedeck_cmd to the addressed panel's webview.postMessage
//   - report + tombstone disposed panels so a retained-but-closed panel can't linger
//   - emit the alive heartbeat the canary (#3) waits for
//
// Everything is injected (manager, transport, focus, writeAlive, now) so the logic is
// unit-testable without a running VS Code.

export function createHostBridge({
  manager,
  transport,
  windowId,
  focus = () => ({ focused: false }),
  writeAlive = () => {},
  now = () => Date.now(),
}) {
  if (!manager) throw new Error('host bridge requires a manager');
  if (!transport) throw new Error('host bridge requires a transport');
  const tombstones = new Set();

  const send = (event) => transport.send({ ...event, windowId, ts: now() });

  function resolvePanel(sessionId) {
    const sid = sessionId || manager.activeSessionId;
    if (!sid) return { sid, panel: null, reason: 'no active session' };
    if (tombstones.has(sid)) return { sid, panel: null, reason: 'tombstoned' };
    const panel = manager.sessionPanels?.get?.(sid);
    if (!panel || !panel.webview) return { sid, panel: null, reason: 'no panel' };
    return { sid, panel, reason: null };
  }

  return {
    tombstones, // exposed for tests/inspection

    // announce this window's focus + active chat
    reportFocus() {
      return send({ type: 'focus', focused: !!focus().focused, activeSessionId: manager.activeSessionId ?? null });
    },

    // forward a webview-originated event (state snapshot / command ack) to the hub
    relay(evt) {
      return send({ ...evt, kind: evt.kind, relayed: true });
    },

    // route a hub command to the addressed chat's webview (never "current focus")
    async handleCommand(cmd) {
      const { sid, panel, reason } = resolvePanel(cmd.sessionId);
      if (!panel) {
        await send({ type: 'result', ok: false, error: reason, sessionId: sid ?? null, op: cmd.op, id: cmd.id });
        return { routed: false, reason, sid };
      }
      panel.webview.postMessage({ type: 'claudedeck_cmd', op: cmd.op, value: cmd.value, id: cmd.id });
      return { routed: true, sid };
    },

    // a panel/session went away: tombstone it and tell the hub
    async disposePanel(sessionId) {
      if (!sessionId) return;
      tombstones.add(sessionId);
      manager.sessionPanels?.delete?.(sessionId);
      await send({ type: 'chat_closed', sessionId });
    },

    // runtime liveness: write the heartbeat file (canary) + notify the hub
    async alive() {
      writeAlive();
      await send({ type: 'alive' });
    },
  };
}
