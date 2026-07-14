// Webview bridge logic — the read path (live signals) + per-chat write path.
//
// The in-closure store-init splice (runs only in the real webview, where the app store
// and the per-chat view-model `Cf` are in scope) hands the store to this factory. Cf's
// signals are preact-style: `{ value, subscribe(fn) }` where subscribe fires immediately
// then on change. This module:
//   - captures exactly ONE Cf per active panel, survives rerender, re-subscribes
//   - posts coalesced state snapshots (stamped with patchVersion) for the host to relay
//   - drives the chat's OWN methods on command (set_model / toggle_thinking /
//     enable_ultracode), guarding the same conditions the UI checks
//   - two-phase ack: `accepted` (method returned) then `confirmed` (the signal echoes
//     the applied value)
//
// Effort LEVELS (low..xhigh, auto) are NOT driven here — they are ⊙GLOBAL and go through
// settings.json (patch/effort.js, #6). Only the dial's "max" (ultracode) is a webview
// action. `effortLevel` is still reported in snapshots for display (not authoritative).
//
// Everything is injected (store, post, scheduling) so the logic is unit-testable with
// fake signals — no running webview.

const val = (sig) => {
  try { return sig && typeof sig.value !== 'undefined' ? sig.value : undefined; } catch { return undefined; }
};

export function createWebviewBridge({
  store,
  post,
  patchVersion = 1,
  schedule = (fn) => setTimeout(fn, 0), // coalescing scheduler (injectable for tests)
}) {
  if (!store) throw new Error('webview bridge requires a store');
  if (typeof post !== 'function') throw new Error('webview bridge requires a post() function');

  let cur = null;            // the one bound Cf
  let sigUnsubs = [];        // unsubscribes for cur's signals
  let flushQueued = false;
  const pending = [];        // pending two-phase confirmations

  const CF_SIGNALS = ['sessionId', 'modelSelection', 'currentModelInfo', 'effortLevel', 'ultracodeEnabled', 'thinkingLevelOverride'];

  function snapshot() {
    if (!cur) return;
    const mi = val(cur.currentModelInfo) || {};
    const catalog = (cur.claudeConfig && cur.claudeConfig.models) || [];
    post({
      type: 'claudedeck_evt', kind: 'state', patchVersion,
      sessionId: val(cur.sessionId) ?? null,
      modelOverride: val(cur.modelSelection) ?? null,
      modelEffective: (mi.value || mi.resolvedModel) || null,
      modelLabel: mi.label || null,
      effort: val(cur.effortLevel) ?? null,          // display only — settings.json is authoritative
      ultracode: val(cur.ultracodeEnabled) || false,
      thinking: val(cur.thinkingLevelOverride) ?? null,
      catalog: catalog.map((m) => ({ value: m.value, label: m.label })),
    });
  }

  function evalPending() {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].check()) {
        const p = pending[i];
        post({ type: 'claudedeck_evt', kind: 'result', patchVersion, op: p.op, id: p.id, phase: 'confirmed', ok: true });
        pending.splice(i, 1);
      }
    }
  }

  function scheduleFlush() {
    if (flushQueued) return;
    flushQueued = true;
    schedule(() => { flushQueued = false; snapshot(); evalPending(); });
  }

  function teardown() { for (const u of sigUnsubs) { try { u(); } catch { /* ignore */ } } sigUnsubs = []; }

  // Bind exactly one Cf. If the store re-emits the SAME Cf, do nothing (no double-sub).
  // If it emits a NEW Cf (rerender), drop the old subscriptions and bind the new one.
  function bind(cf) {
    if (!cf || cf === cur) return;
    teardown();
    cur = cf;
    for (const key of CF_SIGNALS) {
      const sig = cf[key];
      if (sig && typeof sig.subscribe === 'function') {
        try { sigUnsubs.push(sig.subscribe(() => scheduleFlush())); } catch { /* ignore */ }
      }
    }
    scheduleFlush();
  }

  function accept(op, id, ok, error) {
    post({ type: 'claudedeck_evt', kind: 'result', patchVersion, op, id, phase: 'accepted', ok, ...(error ? { error } : {}) });
  }

  return {
    get current() { return cur; },
    _pending: pending, // for tests/inspection

    // subscribe to the active-session signal so every panel switch / rerender rebinds.
    attach() {
      const as = store.activeSession;
      if (as && typeof as.subscribe === 'function') {
        sigUnsubs.push(as.subscribe(() => bind(val(as))));
      }
      bind(val(as));
      post({ type: 'claudedeck_evt', kind: 'hello', patchVersion });
    },

    resync() { snapshot(); },

    // Drive the chat's own method after the same guards the UI checks. Two-phase ack.
    handleCommand(cmd) {
      const cf = cur;
      if (!cf) { accept(cmd.op, cmd.id, false, 'no active chat'); return { ok: false, reason: 'no active chat' }; }

      switch (cmd.op) {
        case 'resync': snapshot(); return { ok: true };

        case 'set_model': {
          if (cf.started && val(cf.started) === false) { accept('set_model', cmd.id, false, 'not started'); return { ok: false, reason: 'not started' }; }
          const catalog = (cf.claudeConfig && cf.claudeConfig.models) || [];
          if (catalog.length && !catalog.some((m) => m.value === cmd.value)) {
            accept('set_model', cmd.id, false, 'not in catalog'); return { ok: false, reason: 'not in catalog' };
          }
          try { cf.setModel({ value: cmd.value }); } catch (e) { accept('set_model', cmd.id, false, String(e && e.message || e)); return { ok: false, reason: 'threw' }; }
          accept('set_model', cmd.id, true);
          pending.push({ op: 'set_model', id: cmd.id, check: () => val(cf.modelSelection) === cmd.value });
          scheduleFlush();
          return { ok: true };
        }

        case 'toggle_thinking': {
          const nowOn = val(cf.thinkingLevelOverride);
          const next = (nowOn === 'default_on') ? 'off' : 'default_on';
          try { cf.setThinkingLevel(next); } catch (e) { accept('toggle_thinking', cmd.id, false, String(e && e.message || e)); return { ok: false }; }
          accept('toggle_thinking', cmd.id, true);
          pending.push({ op: 'toggle_thinking', id: cmd.id, check: () => val(cf.thinkingLevelOverride) === next });
          scheduleFlush();
          return { ok: true, next };
        }

        case 'enable_ultracode': { // the dial's "max" effort position
          try { cf.enableUltracode(); } catch (e) { accept('enable_ultracode', cmd.id, false, String(e && e.message || e)); return { ok: false }; }
          accept('enable_ultracode', cmd.id, true);
          pending.push({ op: 'enable_ultracode', id: cmd.id, check: () => val(cf.ultracodeEnabled) === true });
          scheduleFlush();
          return { ok: true };
        }

        default:
          accept(cmd.op, cmd.id, false, 'unknown op');
          return { ok: false, reason: 'unknown op' };
      }
    },
  };
}
