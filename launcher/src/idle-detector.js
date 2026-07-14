// launcher/src/idle-detector.js — classify Claude's Ink TUI as idle|busy|awaiting-permission|
// unknown. V4: busy is detected in TIME, not by buffer presence. The "esc to interrupt" footer /
// spinner text LINGERS in any byte buffer after a turn ends (Ink erases it on screen via cursor
// ops, but the bytes stay) — so "footer present in a window" latches busy forever, which was the
// V2/V3 bug and made short turns permanently refuse. Instead: every fed chunk containing a footer/
// spinner stamps lastBusyAt=now(); state() is evaluated LIVE and is busy only while
// now()-lastBusyAt < quiescenceMs (Ink stops repainting the footer when idle => the stamp goes
// stale => idle). permission/prompt are presence-in-window (static UI; refuse-safe). Default
// unknown -> control REFUSES. sawBusySince() edge-latches for the submit verifier. Validate against
// launcher/fixtures/* (Task 0, fail-loud) — retune THERE; failure mode is refuse-safe.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB012]|\x1b[78Mc]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const FOOTER = /esc to interrupt/i;                            // busy iff EMITTED recently (time-based)
const PERMISSION = /❯\s*\d+\.\s|\besc to (reject|cancel)\b/i;  // ❯-selected choice block
const PROMPT = /[│|]\s*>\s*(?:\x1b|\s|$)/;                     // the input box prompt

export function createIdleDetector({ windowBytes = 2000, quiescenceMs = 400, now = () => Date.now() } = {}) {
  let recent = '';       // bounded tail (for permission/prompt presence only)
  let lastBusyAt = -1e15; // when a footer/spinner was last EMITTED (time-based busy)
  const classify = () => {
    const clean = stripAnsi(recent);
    if (PERMISSION.test(clean)) return 'awaiting-permission';
    if (now() - lastBusyAt < quiescenceMs) return 'busy';       // footer emitted recently => busy
    if (PROMPT.test(clean)) return 'idle';
    return 'unknown';
  };
  return {
    feed(chunk) {
      const c = String(chunk);
      recent = (recent + c).slice(-windowBytes);
      const cleanChunk = stripAnsi(c);
      if (FOOTER.test(cleanChunk) || SPINNER.test(cleanChunk)) lastBusyAt = now();  // busy stamp from THIS chunk
      return classify();
    },
    state: () => classify(),                 // LIVE — re-evaluates the time debounce on every call
    sawBusySince: (t) => lastBusyAt >= t,    // did a turn start (footer/spinner) after time t?
  };
}
