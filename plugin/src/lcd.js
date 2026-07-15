// LCD feedback rendering — pure: (dial, targetState, uiState) -> a setFeedback payload
// for the 200x100 layout. No @elgato, no hardware; fully unit-testable. The action (#23)
// owns the animation clock (advancing marqueeOffset/spinnerFrame) and maps iconState to
// a layout image; here everything is a pure function of inputs.
//
// Layout item keys (must match plugin/layouts/dial.json, #23):
//   title     — marquee line (chat context / ⊙GLOBAL / status)
//   value     — the main value (model short name / effort level / browse value)
//   icon      — glyph state (idle | spinner | ok | warn)
//   indicator — 0..100 gauge (effort ladder position), or -1 to hide

import { EFFORT_LADDER } from '../../patch/effort-ladder.js';

export const LCD_KEYS = { title: 'title', value: 'value', icon: 'icon', indicator: 'indicator' };

// Scroll `text` within `width` chars only when it overflows; otherwise return it as-is.
export function marquee(text, offset = 0, width = 14) {
  if (!text) return '';
  if (text.length <= width) return text;
  const pad = text + '   •   ';
  const i = ((offset % pad.length) + pad.length) % pad.length;
  return (pad + pad).slice(i, i + width);
}

export function overflows(text, width = 14) { return !!text && text.length > width; }

// Short, human model label from a descriptor value.
export function modelShort(snap) {
  if (snap?.modelLabel) return snap.modelLabel;
  const v = snap?.model;
  if (!v) return 'Default';
  return String(v).replace(/^claude-/, '').replace(/\[.*?\]$/, '').replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export function effortLabel(effort) {
  if (effort == null || effort === 'auto') return 'Auto';
  return String(effort);
}

// Effort position on the ladder as a 0..100 gauge value. 'auto'/unknown (not ladder
// positions) sit at the gauge floor.
export function effortPct(effort) {
  const i = EFFORT_LADDER.indexOf(effort);
  return i < 0 ? 0 : Math.round((i / (EFFORT_LADDER.length - 1)) * 100);
}

// uiState: { phase: 'ok'|'browsing'|'applying'|'confirmed'|'error'|'reload-needed',
//            browseValue?, marqueeOffset? }
export function render(dial, targetState, ui = {}) {
  const off = ui.marqueeOffset ?? 0;
  const chat = (ts) => marquee(ts.summary || ts.sessionId || 'chat', off);
  const base = { title: '', value: '', icon: 'idle', indicator: -1, state: '' };

  // sentinels first
  if (targetState.kind === 'no-vscode') return { ...base, title: 'Claude Deck', value: 'No VS Code', icon: 'warn', state: 'no-vscode' };
  if (targetState.kind === 'no-chat') return { ...base, title: 'Claude Deck', value: 'No chat', state: 'no-chat' };
  if (targetState.kind === 'not-started') return { ...base, title: chat(targetState), value: 'Not started', state: 'not-started' };

  // ok — dial-specific
  if (ui.phase === 'reload-needed') return { ...base, title: chat(targetState), value: 'Reload needed', icon: 'warn', state: 'reload-needed' };

  const iconFor = (p) => (p === 'applying' || p === 'compacting' ? 'spinner' : p === 'confirmed' ? 'ok' : p === 'error' ? 'warn' : 'idle');

  // While browsing AND while the pick is being applied/confirmed, show the user's pick —
  // flashing back to the old value mid-apply reads as "it didn't take".
  const showPick = ui.browseValue != null && ['browsing', 'applying', 'confirmed'].includes(ui.phase);

  if (dial === 'effort') {
    // effort is ⊙GLOBAL — the marquee says so rather than a per-chat name. ui.heldValue: a
    // just-applied level held over the mirror window so a stray repaint can't flash the old one.
    const eff = showPick ? ui.browseValue : (ui.heldValue != null ? ui.heldValue : targetState.effort);
    return {
      title: marquee('⊙ GLOBAL', off), value: effortLabel(eff),
      icon: iconFor(ui.phase),
      indicator: effortPct(eff),
      state: ui.phase === 'browsing' ? 'browsing' : (ui.phase || 'ok'),
    };
  }
  // model dial — the Compacting screen is reserved for the dial's own compact command
  // (ui.phase). A merely-busy chat (any generation sets the busy signal) keeps its model
  // visible and gets the spinner as a working cue instead — busy ≠ compacting (#32).
  if (ui.phase === 'compacting') {
    return { ...base, title: chat(targetState), value: 'Compacting', icon: 'spinner', indicator: -1, state: 'compacting' };
  }
  const interacting = ['browsing', 'applying', 'confirmed', 'error'].includes(ui.phase);
  const busyIdle = !!targetState.busy && !interacting;
  // ui.heldValue: a just-set model the bridge hasn't caught up to (its currentMainLoopModel lags a
  // setModel until a turn runs) — hold it on phase:'ok' repaints so the LCD never flashes back.
  const value = showPick ? modelShort({ model: ui.browseValue })
    : (ui.heldValue != null ? modelShort({ model: ui.heldValue }) : modelShort(targetState));
  return {
    title: chat(targetState), value,
    icon: busyIdle ? 'spinner' : iconFor(ui.phase),
    indicator: -1,
    state: ui.phase === 'browsing' ? 'browsing' : busyIdle ? 'busy' : (ui.phase || 'ok'),
  };
}

// Convert a render result into an @elgato setFeedback object (keyed by layout item keys).
export function toFeedback(r) {
  const fb = { [LCD_KEYS.title]: r.title, [LCD_KEYS.value]: r.value, [LCD_KEYS.icon]: r.icon };
  if (r.indicator >= 0) fb[LCD_KEYS.indicator] = r.indicator;
  return fb;
}
