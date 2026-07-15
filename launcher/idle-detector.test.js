import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createIdleDetector } from './src/idle-detector.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// TIME-based busy debounce — controllable clock (no clear-screen assumption).
function clk() { const c = { t: 1000 }; return { d: createIdleDetector({ quiescenceMs: 400, now: () => c.t }), c }; }

test('busy does NOT latch — it clears after the footer STOPS being emitted (time debounce)', () => {
  const { d, c } = clk();
  d.feed('esc to interrupt'); assert.equal(d.state(), 'busy');   // footer emitted @1000
  c.t = 1200; assert.equal(d.state(), 'busy');                   // still within 400ms quiescence
  c.t = 1500; d.feed('| > ');                                    // 500ms since last footer; prompt shown
  assert.equal(d.state(), 'idle');
});

test('busy STAYS busy while the footer keeps repainting (no false idle mid-turn)', () => {
  const { d, c } = clk();
  for (const t of [1000, 1300, 1600, 1900]) { c.t = t; d.feed('...streaming... esc to interrupt'); }
  assert.equal(d.state(), 'busy');   // footer re-emitted each frame => never goes stale
});

test('sawBusySince edge-latches a transient busy for the submit verifier', () => {
  const { d, c } = clk(); const armed = c.t;
  d.feed('esc to interrupt'); c.t += 500; d.feed('| > ');
  assert.equal(d.state(), 'idle');
  assert.equal(d.sawBusySince(armed), true);
});

test('a "1." numbered list WITHOUT a selector is NOT a permission prompt', () => {
  const { d } = clk();
  d.feed('Here are options:\n1. Yes it works\n2. No\n| > ');
  assert.equal(d.state(), 'idle');
});

test('a real ❯ permission block => awaiting-permission (never idle)', () => {
  const { d } = clk();
  d.feed('Do you want to proceed?\n❯ 1. Yes\n  2. No\n');
  assert.equal(d.state(), 'awaiting-permission');
});

test('streaming text with no footer/prompt/permission => unknown (refuse-safe)', () => {
  const { d } = clk();
  d.feed('some streaming text with no prompt box and no footer');
  assert.equal(d.state(), 'unknown');
});

// ── Fail-loud fixture tests (Task 0) ────────────────────────────────────────────────────────────
// Real `claude` 2.x TUI frames captured by tools/capture-fixtures.mjs. These are the ground truth
// the classifier must satisfy; a missing fixture fails LOUDLY (ENOENT) so the suite can't pass
// without them. The tricky case is `reply-then-idle`: a just-completed turn whose "✻ Churned for 3s"
// summary contains a lone spinner glyph — it must read idle, NOT busy.
const FIXTURES = {
  'idle': 'idle',                       // startup idle — prompt buried under a Fable-5 promo + usage banner
  'reply-then-idle': 'idle',            // turn just finished — lone "✻" + "✨ ready" must be idle
  'busy': 'busy',                       // "· Roosting…" gerund working line
  'busy-sample-1500': 'busy',           // "✽ Musing…" mid-turn frame
  'busy-sample-2500': 'busy',
  'busy-sample-3500': 'busy',
  'trust-prompt': 'awaiting-permission', // "❯ 1. Yes, I trust this folder" onboarding gate
};
for (const [name, expected] of Object.entries(FIXTURES)) {
  test(`fixture ${name}.txt classifies as ${expected}`, () => {
    const raw = readFileSync(join(FIX, `${name}.txt`), 'utf8');  // ENOENT here = fixture missing → fail loud
    const d = createIdleDetector();                              // real wall clock: stamp+classify are one sync call
    assert.equal(d.feed(raw), expected, `${name}.txt should classify as ${expected}`);
  });
}
