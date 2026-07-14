// Dial action controller — the behavior behind each encoder action, independent of the
// @elgato SDK so it is unit-testable. Composes browse (value stepping) + dial-control
// (debounce/seq/ack) + lcd (render) and drives the two write paths:
//   - model dial  -> hub.sendToTarget({op:'set_model'})  (routed to the focused chat)
//   - effort dial -> setEffort(level) locally (⊙GLOBAL settings.json); 'max' also sends
//                    enable_ultracode to the focused chat's webview.
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

  const dc = createDialControl({
    debounceMs, setTimer, clearTimer,
    onApply: ({ seq, value }) => apply(seq, value),
  });

  const state = () => hub.targetState();
  const paint = (ui) => setFeedback(toFeedback(render(dial, state(), ui)));

  function apply(seq, value) {
    if (dial === 'model') {
      hub.sendToTarget({ op: 'set_model', value, id: seq });
      paint({ phase: 'applying' });
      return;
    }
    // effort: ⊙GLOBAL local write (closed-loop inside setEffort)
    try {
      if (value === 'max') { setEffort('max'); hub.sendToTarget({ op: 'enable_ultracode', id: seq }); }
      else setEffort(value);
      paint({ phase: 'confirmed' });
    } catch {
      paint({ phase: 'error' });
    }
  }

  return {
    onRotate(ticks) {
      const s = state();
      if (dial === 'model') {
        const cur = s.kind === 'ok' ? s.model : null;
        browseValue = browseModel(s.catalog || [], cur, ticks);
      } else {
        const cur = s.kind === 'ok' ? s.effort : 'auto';
        browseValue = browseEffort(cur, ticks);
      }
      dc.rotate(browseValue);
      paint({ phase: 'browsing', browseValue });
    },

    onPress() {
      hub.sendToTarget({ op: dial === 'model' ? 'resync' : 'toggle_thinking' });
      paint({ phase: 'ok' });
    },

    onUpdate() { paint({ phase: 'ok' }); },

    onResult(result) {
      const cls = dc.ack(result.id);
      if (cls === 'confirmed') paint({ phase: 'confirmed' });
      else if (result.ok === false) paint({ phase: 'error' });
    },

    _dc: dc,
    get browseValue() { return browseValue; },
  };
}
