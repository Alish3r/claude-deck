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

import { EFFORT_LADDER } from '../../patch/effort.js';

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

// Effort position on the ladder as a 0..100 gauge value.
export function effortPct(effort) {
  const key = effort == null ? 'auto' : effort;
  const i = EFFORT_LADDER.indexOf(key);
  const idx = i < 0 ? 0 : i;
  return Math.round((idx / (EFFORT_LADDER.length - 1)) * 100);
}

// uiState: { phase: 'ok'|'browsing'|'applying'|'confirmed'|'error'|'reload-needed',
//            browseValue?, marqueeOffset? }
export function render(dial, targetState, ui = {}) {
  const off = ui.marqueeOffset ?? 0;
  const chat = (ts) => marquee(ts.windowId ? `${ts.windowId} ▸ ${ts.sessionId ?? ''}`.trim() : (ts.sessionId ?? 'chat'), off);
  const base = { title: '', value: '', icon: 'idle', indicator: -1, state: '' };

  // sentinels first
  if (targetState.kind === 'no-vscode') return { ...base, title: 'Claude Deck', value: 'No VS Code', icon: 'warn', state: 'no-vscode' };
  if (targetState.kind === 'no-chat') return { ...base, title: 'Claude Deck', value: 'No chat', state: 'no-chat' };
  if (targetState.kind === 'not-started') return { ...base, title: chat(targetState), value: 'Not started', state: 'not-started' };

  // ok — dial-specific
  if (ui.phase === 'reload-needed') return { ...base, title: chat(targetState), value: 'Reload needed', icon: 'warn', state: 'reload-needed' };

  const iconFor = (p) => (p === 'applying' ? 'spinner' : p === 'confirmed' ? 'ok' : p === 'error' ? 'warn' : 'idle');

  if (dial === 'effort') {
    // effort is ⊙GLOBAL — the marquee says so rather than a per-chat name
    const value = ui.phase === 'browsing' ? effortLabel(ui.browseValue) : effortLabel(targetState.effort);
    return {
      title: marquee('⊙ GLOBAL', off), value,
      icon: iconFor(ui.phase),
      indicator: effortPct(ui.phase === 'browsing' ? ui.browseValue : targetState.effort),
      state: ui.phase === 'browsing' ? 'browsing' : (ui.phase || 'ok'),
    };
  }
  // model dial
  const value = ui.phase === 'browsing' ? modelShort({ model: ui.browseValue }) : modelShort(targetState);
  return {
    title: chat(targetState), value,
    icon: iconFor(ui.phase),
    indicator: -1,
    state: ui.phase === 'browsing' ? 'browsing' : (ui.phase || 'ok'),
  };
}

// Convert a render result into an @elgato setFeedback object (keyed by layout item keys).
export function toFeedback(r) {
  const fb = { [LCD_KEYS.title]: r.title, [LCD_KEYS.value]: r.value, [LCD_KEYS.icon]: r.icon };
  if (r.indicator >= 0) fb[LCD_KEYS.indicator] = r.indicator;
  return fb;
}
