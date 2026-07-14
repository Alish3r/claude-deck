// Per-dial command control: coalesce rotation, apply after a debounce, track in-flight
// with a monotonic seq, and drop stale acks.
//
// The action computes the browsed value on each tick (browse freely); this schedules the
// APPLY ~500ms after rotation stops, emitting one command with an incrementing seq. A
// press applies immediately (flushNow). Acks for superseded seqs are stale and ignored.
// Timers are injected so the debounce is deterministic in tests.

export function createDialControl({
  debounceMs = 500,
  onApply,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof onApply !== 'function') throw new Error('dial control requires onApply');
  let pending = null;    // latest browsed value awaiting apply
  let handle = null;
  let seq = 0;
  const inFlight = new Map(); // seq -> value

  function schedule() {
    if (handle) clearTimer(handle);
    handle = setTimer(fire, debounceMs);
  }

  function fire() {
    handle = null;
    if (pending == null) return;
    const value = pending; pending = null;
    const s = ++seq;
    inFlight.set(s, value);
    // Un-acked entries (lost results) must not accumulate forever — anything this far
    // behind the head is long superseded and its late ack would be 'stale' anyway.
    for (const k of inFlight.keys()) if (k < s - 8) inFlight.delete(k);
    onApply({ seq: s, value });
    return s;
  }

  // A rotation tick landed on `value` (already browsed/clamped by the action).
  function rotate(value) { pending = value; schedule(); }

  // Apply immediately (dial press, or "commit now").
  function flushNow() { if (handle) { clearTimer(handle); handle = null; } return fire(); }

  // Result came back for seq `s`. Returns 'confirmed' (latest), 'stale' (superseded), or
  // 'unknown' (not in flight). Stale acks must not update the LCD to an old value.
  function ack(s) {
    if (!inFlight.has(s)) return 'unknown';
    inFlight.delete(s);
    return s === seq ? 'confirmed' : 'stale';
  }

  return {
    rotate, flushNow, ack,
    get seq() { return seq; },
    get pending() { return pending; },
    inFlight,
  };
}
