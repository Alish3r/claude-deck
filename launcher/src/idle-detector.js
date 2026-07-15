// launcher/src/idle-detector.js — classify Claude's Ink TUI as idle|busy|awaiting-permission|
// unknown. V5: regexes retuned against REAL captured frames (launcher/fixtures/*, Task 0). The
// actual claude 2.x TUI does NOT show "esc to interrupt" and does NOT use braille spinners or a
// "│ >" input box — those were a mental model. Real signals:
//   busy       → a gerund status line ending in "…" (U+2026), e.g. "✽ Musing…", plus a sparkle
//                spinner RUN "✻✶*✢". The lone "✻" in the DONE summary "✻ Churned for 3s" is NOT a
//                run and carries no "…", so it correctly reads as idle.
//   idle       → the "✨ ready" status footer (present in every idle frame, zero busy/permission).
//   permission → a "❯ 1." numbered selection menu (trust gate, tool approval, onboarding).
// V4 architecture kept: busy is detected in TIME, not by buffer presence. Working-line bytes LINGER
// in any byte buffer after a turn ends (Ink erases them on screen via cursor ops, not by emitting
// spaces), so "working line present in a window" latches busy forever (the V2/V3 bug — short turns
// permanently refused). Instead: every fed chunk containing a busy signal stamps lastBusyAt=now();
// state() is evaluated LIVE and is busy only while now()-lastBusyAt < quiescenceMs. idle/permission
// are presence-in-window (static UI; refuse-safe). Default unknown -> control REFUSES.
// sawBusySince() edge-latches for the submit verifier. Retune against the fixtures, not from memory.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB012]|\x1b[78Mc]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
// Busy signals (stamp lastBusyAt when EMITTED). WORKING: a "…" ellipsis (claude's gerund working
// line) or the legacy "esc to interrupt" footer (kept defensively though current claude omits it).
const WORKING = /…|\besc to interrupt\b/i;
// SPINNER: a braille spinner (generic CLIs) OR a RUN of 2+ sparkle glyphs (claude's animation) —
// a run, so the single "✻" in "✻ Churned for 3s" (turn complete) does NOT stamp busy.
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|[✢✳✶✻✽✺✵][✢✳✶✻✽✺✵*·\s]*[✢✳✶✻✽✺✵]/;
const PERMISSION = /❯\s*\d+\.\s|\besc to (reject|cancel)\b|Enter to confirm\b/i;   // ❯-selected choice block
const READY = /✨\s*ready\b|⏸\s*manual mode\b/i;                                  // idle status footer
const PROMPT_BOX = /[│|]\s*>\s*(?:\x1b|\s|$)/;                                    // classic input box (other CLIs)

export function createIdleDetector({ windowBytes = 2000, quiescenceMs = 400, now = () => Date.now() } = {}) {
  let recent = '';       // bounded tail (for permission/idle presence only)
  let lastBusyAt = -1e15; // when a busy signal was last EMITTED (time-based busy)
  const classify = () => {
    const clean = stripAnsi(recent);
    if (PERMISSION.test(clean)) return 'awaiting-permission';
    if (now() - lastBusyAt < quiescenceMs) return 'busy';       // busy signal emitted recently => busy
    if (READY.test(clean) || PROMPT_BOX.test(clean)) return 'idle';
    return 'unknown';
  };
  return {
    feed(chunk) {
      const c = String(chunk);
      recent = (recent + c).slice(-windowBytes);
      const cleanChunk = stripAnsi(c);
      if (WORKING.test(cleanChunk) || SPINNER.test(cleanChunk)) lastBusyAt = now();  // busy stamp from THIS chunk
      return classify();
    },
    state: () => classify(),                 // LIVE — re-evaluates the time debounce on every call
    sawBusySince: (t) => lastBusyAt >= t,    // did a turn start (working line/spinner) after time t?
  };
}
