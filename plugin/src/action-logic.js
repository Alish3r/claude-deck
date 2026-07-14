// Dial action controller — the behavior behind each encoder action, independent of the
// @elgato SDK so it is unit-testable. Composes browse (value stepping) + dial-control
// (debounce/seq/ack) + lcd (render) and drives the two write paths:
//   - model dial  -> hub.sendToTarget({op:'set_model'})  (routed to the focused chat)
//   - effort dial -> setEffort(level) locally (⊙GLOBAL settings.json); 'ultracode' also
//                    sends enable_ultracode to the focused chat's webview.
//
// The @elgato action (#23 glue) forwards onDialRotate/onDialDown here and provides
// setFeedback + the hub + the settings writer.

import { render, toFeedback } from './lcd.js';
import { createDialControl } from './dial-control.js';
import { browseModel, browseEffort } from './browse.js';

export function createDialAction({
  dial,                 // 'model' | 'effort'
  hub,                  // { sendToTarget(cmd), targetState() }
  setFeedback,          // (feedbackObj) => void
  setEffort,            // (level) => void   — required for the effort dial (⊙GLOBAL)
  debounceMs = 500,
  setTimer, clearTimer,
}) {
  let browseValue = null;
  let browseTarget = null; // {windowId,sessionId} captured at the FIRST tick of a browse:
  // the debounced apply must hit the chat the user was looking at when they started
  // turning, not whatever window grabbed focus by the time the debounce fires.
  let lastActivity = 0; // for idle() so a background repaint won't clobber a live browse
  let spin = 0;         // busy-spinner frame counter (advanced by tick())
  let marqueeOffset = 0; // chat-name scroll position (advanced by tick() when overflowing)
  const HEADER_CHARS = 28; // must match render-lcd's header window

  const dc = createDialControl({
    debounceMs, setTimer, clearTimer,
    onApply: ({ seq, value }) => apply(seq, value),
  });

  const state = () => hub.targetState();
  const idle_ = () => Date.now() - lastActivity > 1000; // shared by idle() + tick()
  // `_raw` carries the exact (targetState, ui) inputs alongside the computed text-shape
  // feedback, so a caller that wants richer rendering (e.g. a rasterized pixmap) can
  // reproduce the identical phase/browseValue without re-deriving it from display text.
  // Every paint carries the persistent marquee offset so interactions don't reset the
  // scrolling chat-name header.
  const paint = (ui0) => {
    const ui = { marqueeOffset, ...ui0 };
    setFeedback({ ...toFeedback(render(dial, state(), ui)), _raw: { targetState: state(), ui } });
  };

  // ids are dial-namespaced ("model:3") — both dials count seq from 1, and results are
  // fanned out; a bare integer from the OTHER dial could falsely confirm ours.
  const nsId = (seq) => `${dial}:${seq}`;
  const parseId = (id) => {
    if (typeof id !== 'string' || !id.startsWith(`${dial}:`)) return null;
    const n = Number(id.slice(dial.length + 1));
    return Number.isFinite(n) ? n : null;
  };

  function apply(seq, value) {
    const target = browseTarget || {};
    browseTarget = null;
    browseValue = null; // next browse session re-anchors at live state, not this stale pick
    if (dial === 'model') {
      hub.sendToTarget({ op: 'set_model', value, id: nsId(seq), ...target });
      paint({ phase: 'applying', browseValue: value }); // keep showing the user's pick, not the old model
      return;
    }
    // effort: ⊙GLOBAL local write first (closed-loop inside setEffort — settings.json is
    // the sole authority), then mirror to the focused chat so its picker FOLLOWS the dial.
    try {
      if (value === 'ultracode') {
        setEffort('ultracode');
        hub.sendToTarget({ op: 'enable_ultracode', id: nsId(seq), ...target });
      } else {
        setEffort(value);
        // set_effort = the webview's setEffortLevel: it updates the visible picker AND is
        // the bundle's only ultracode-off path (clears the flag as a side effect), so it is
        // sent unconditionally — no lag-prone "is the chat in ultracode?" snapshot check.
        // The mirror carries the SAME level just written closed-loop (auto → undefined so
        // the picker mirrors the key removal); the display can never contradict the file.
        hub.sendToTarget({ op: 'set_effort', value: value === 'auto' ? undefined : value, id: nsId(seq), ...target });
      }
      paint({ phase: 'confirmed', browseValue: value });
    } catch {
      paint({ phase: 'error' });
    }
  }

  return {
    onRotate(ticks) {
      lastActivity = Date.now();
      const s = state();
      // No target = nothing to browse or write. Without this the effort dial would
      // silently rewrite settings.json while the LCD shows a "No VS Code" sentinel.
      if (s.kind !== 'ok') { paint({ phase: 'ok' }); return; }
      if (!browseTarget) browseTarget = { windowId: s.windowId, sessionId: s.sessionId };
      // Mid-browse, successive ticks anchor at the CURRENT browse position — anchoring at
      // hub state made every tick recompute from the same start, collapsing a five-detent
      // turn into a single step.
      if (dial === 'model') {
        // anchor on the catalog VALUE the running model maps to (s.model is a resolved
        // slug like "claude-opus-4-8[1m]" that isn't itself a catalog .value)
        const cur = browseValue != null ? browseValue : (s.modelActive || s.model);
        browseValue = browseModel(s.catalog || [], cur, ticks);
      } else {
        // anchor on the AUTHORITATIVE global effort, not the per-chat display signal —
        // stepping from a stale per-chat value would write a wrong GLOBAL effort (round-2 #1)
        const cur = browseValue != null ? browseValue : (s.effortGlobal ?? s.effort);
        browseValue = browseEffort(cur, ticks);
      }
      dc.rotate(browseValue);
      paint({ phase: 'browsing', browseValue });
    },

    onPress() {
      lastActivity = Date.now();
      if (dial === 'model') {
        // Press = /compact on the focused chat. Paint the compacting state optimistically
        // for instant feedback; it holds ~1s (tick skips repaints while recently active),
        // then the live view takes over — a busy chat shows model + spinner (#32).
        hub.sendToTarget({ op: 'compact' });
        paint({ phase: 'compacting' });
        return;
      }
      hub.sendToTarget({ op: 'toggle_thinking' });
      paint({ phase: 'ok' });
    },

    onUpdate() { paint({ phase: 'ok' }); },
    idle: idle_,

    // Animation clock (~120ms from the SDK layer). A rasterized LCD frame can't self-animate,
    // so we push successive frames for the two continuous states: the busy-spinner chip and
    // the chat-name marquee (title longer than the header window). A no-op otherwise —
    // a short-titled idle chat never rasterizes.
    tick() {
      if (dial !== 'model') return;
      const s = state();
      if (s.kind !== 'ok' || !idle_()) return;
      const scrolls = (s.summary || s.sessionId || '').length > HEADER_CHARS;
      if (!s.busy && !scrolls) return;
      if (s.busy) spin = (spin + 1) % 24;
      if (scrolls) marqueeOffset += 2; // PIXELS per ~120ms frame — smooth ≈17px/s scroll
      paint({ phase: 'ok', spin });
    },

    onResult(result) {
      const seq = parseId(result.id);
      if (seq != null) {
        const cls = dc.ack(seq);          // always clear the in-flight entry
        if (cls !== 'confirmed') return;  // stale/unknown — superseded, never repaint old values
        // The EFFORT dial's truth is the local setEffort write, which apply() already
        // painted (confirmed/error). Its set_effort/enable_ultracode acks are cosmetic
        // mirrors to the chat picker — a mirror ok:false (no panel / hidden tab) must NOT
        // override a settings.json write that already succeeded. Ignore ack repaints here.
        if (dial === 'effort') return;
        // model dial: an ok:false ack for the LATEST command is a FAILURE, not a confirmation
        paint(result.ok === false
          ? { phase: 'error' }
          : { phase: 'confirmed', browseValue: result.requested });
        return;
      }
      // id-less results (press ops: compact / toggle_thinking) — honor explicit failures only
      if (result.id == null && result.ok === false) paint({ phase: 'error' });
    },

    _dc: dc,
    get browseValue() { return browseValue; },
  };
}
