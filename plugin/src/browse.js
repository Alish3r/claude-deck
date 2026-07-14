// Dial browse logic — given the current value + rotation direction, compute the next
// value. Model wraps around the live catalog; effort clamps along the fixed ladder.
// Pure + tested.

import { EFFORT_LADDER } from '../../patch/effort.js';

export function browseList(list, current, dir, { wrap = false } = {}) {
  if (!list.length) return current;
  let i = list.indexOf(current);
  if (i < 0) i = 0;
  // honor the rotation MAGNITUDE: the Stream Deck+ SDK batches fast spins into one event
  // with ticks=2/3/… — Math.sign() would collapse a 3-detent spin to a single step.
  let n = i + dir;
  if (wrap) n = ((n % list.length) + list.length) % list.length;
  else n = Math.max(0, Math.min(list.length - 1, n));
  return list[n];
}

// Model: cycle the live catalog values, wrapping. (A synthetic "Default" could be
// prepended by the caller; here we browse exactly what the catalog offers.)
export function browseModel(catalog, current, dir) {
  return browseList(catalog.map((m) => m.value), current, dir, { wrap: true });
}

// Effort: clamp along the ⊙GLOBAL ladder (low…ultracode), no wrap (turning past an end
// holds). 'auto' (absent settings key) and junk values aren't ladder positions — any turn
// from them lands on the bottom rung, the predictable entry point.
export function browseEffort(current, dir) {
  if (!EFFORT_LADDER.includes(current)) return EFFORT_LADDER[0];
  return browseList(EFFORT_LADDER, current, dir, { wrap: false });
}
