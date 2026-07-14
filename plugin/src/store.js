// Per-session state cache + target-state derivation.
//
// Ingests the webview snapshots the host relays (kind:'state') keyed by (windowId,
// sessionId), tombstones closed chats, and joins the arbiter's target with the cache to
// produce the single snapshot the dials render/drive — or a sentinel (no-vscode / no-chat).

export function createStore() {
  const cache = new Map();       // "windowId:sessionId" -> snapshot
  const tombstoned = new Set();  // "windowId:sessionId"
  let anyWindowSeen = false;

  const key = (windowId, sessionId) => `${windowId}:${sessionId}`;

  // A relayed webview state snapshot (from host bridge). Carries windowId + sessionId.
  function ingestState(evt) {
    anyWindowSeen = true;
    const sid = evt.sessionId;
    if (!evt.windowId || !sid) return;
    const k = key(evt.windowId, sid);
    if (tombstoned.has(k)) return; // ignore late snapshots for a closed chat
    cache.set(k, {
      windowId: evt.windowId, sessionId: sid,
      model: evt.modelOverride ?? null,
      modelEffective: evt.modelEffective ?? null,
      modelLabel: evt.modelLabel ?? null,
      effort: evt.effort ?? null,
      ultracode: !!evt.ultracode,
      thinking: evt.thinking ?? null,
      catalog: evt.catalog ?? [],
      patchVersion: evt.patchVersion ?? null,
    });
  }

  function markWindowSeen() { anyWindowSeen = true; }

  function tombstone(windowId, sessionId) {
    const k = key(windowId, sessionId);
    tombstoned.add(k);
    cache.delete(k);
  }

  function forgetWindow(windowId) {
    for (const k of [...cache.keys()]) if (k.startsWith(`${windowId}:`)) cache.delete(k);
  }

  // Join the arbiter target with the cache → the render/drive snapshot or a sentinel.
  function targetState(target) {
    if (!anyWindowSeen) return { kind: 'no-vscode' };
    if (!target) return { kind: 'no-chat' };
    if (!target.sessionId) return { kind: 'no-chat', windowId: target.windowId };
    const snap = cache.get(key(target.windowId, target.sessionId));
    if (!snap) return { kind: 'not-started', windowId: target.windowId, sessionId: target.sessionId };
    return { kind: 'ok', ...snap };
  }

  return { ingestState, markWindowSeen, tombstone, forgetWindow, targetState, _cache: cache };
}
