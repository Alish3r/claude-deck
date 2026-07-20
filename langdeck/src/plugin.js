// Lang Cycle — Stream Deck plugin entry (@elgato/streamdeck 2.x).
//
// One Keypad action: it shows the current Windows input language and cycles to the next
// installed layout on press. Split out of the Claude Deck plugin in #29 so deploying the
// language key never disturbs the model/effort dials (and vice versa) — the two plugins
// share no code, no UUID, and no build. All behavior lives in the unit-tested modules
// (lang-logic.js, winlang.js, render-lang.js); this file only binds the SDK.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import sharp from 'sharp'; // native addon — kept external by esbuild, its binary copied by build.mjs
import { createWinLang } from './winlang.js';
import { orderLayouts, nextLayout, langFace } from './lang-logic.js';
import { renderLangSvg } from './render-lang.js';

let winlang = null;
const langContexts = new Map();   // action.id -> { action, seq, warnUntil, pendingTarget, warnTimer }

const WARN_MS = 4000;

// Returns the data URI; it deliberately does NOT push to the device. The caller checks its
// sequence number and only then calls setImage — pushing inside this helper would make the
// stale-frame guard dead code.
async function langPng(face) {
  const svg = renderLangSvg(face);
  const png = await sharp(Buffer.from(svg), { density: 384 }).resize(144, 144).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

// Lazy lifecycle: the co-process exists only while at least one Language key is on a page.
let winlangRunning = false;
function startWinLang() { if (winlang && !winlangRunning) { winlang.start(); winlangRunning = true; } }
function stopWinLangIfIdle() {
  if (winlang && winlangRunning && langContexts.size === 0) { winlang.stop(); winlangRunning = false; }
}

class LangKey extends SingletonAction {
  constructor() {
    super();
    this.manifestId = 'com.alisher.langcycle.lang';  // 2.x routes events on this (no decorator needed)
  }

  // Per-CONTEXT state. SingletonAction is ONE instance shared by every placed key, so
  // `this.renderSeq`/`this.warnUntil` on the class would let a repaint of key B invalidate
  // key A's in-flight render — leaving every key but the last one permanently blank, and
  // painting A's warn dot onto B.
  ctx(action) {
    if (!langContexts.has(action.id)) {
      langContexts.set(action.id, { action, seq: 0, warnUntil: 0, pendingTarget: null, warnTimer: null });
    }
    return langContexts.get(action.id);
  }

  // Stale-frame guard: sharp is async, so a slow render must never land after a newer one.
  // The seq check happens BEFORE the push.
  repaint(action) {
    const c = this.ctx(action);
    const seq = ++c.seq;
    const face = langFace(winlang && winlang.getState(), c.warnUntil);
    langPng(face)
      .then((uri) => { if (seq === c.seq) return action.setImage(uri); })
      .catch((e) => { try { streamDeck.logger.error(`lang paint failed: ${e.message}`); } catch { /* pre-connect */ } });
  }

  async onWillAppear(ev) {
    this.ctx(ev.action);
    startWinLang();                    // lazy: nothing runs until a Language key is placed
    this.repaint(ev.action);
  }

  onWillDisappear(ev) {
    const c = langContexts.get(ev.action.id);
    if (c && c.warnTimer) clearTimeout(c.warnTimer);
    langContexts.delete(ev.action.id);
    stopWinLangIfIdle();               // last key removed -> stop the co-process
  }

  async onKeyDown(ev) {
    if (!winlang) return;
    const c = this.ctx(ev.action);
    const s = winlang.getState();
    const ordered = orderLayouts(s.list, winlang.getPreload());
    if (ordered.length < 2) return this.repaint(ev.action);   // nothing to cycle to

    // Cycle from the last REQUESTED layout, not the last READ one. getState() does not update
    // until the ~150ms read-back completes, so two fast presses would otherwise both compute
    // the same target and the second would be a silent no-op — the cycle would never advance
    // past one step, and with 3+ layouts the third would be unreachable by pressing. A
    // language key is exactly the control users mash. Reproduced during the plan audit.
    const from = c.pendingTarget ?? s.hkl;
    const target = nextLayout(from, ordered);
    if (!target) return this.repaint(ev.action);
    c.pendingTarget = target;

    // NO optimistic paint. Painting the requested language before the read-back confirms it
    // showed a language the user was not typing in for 150-300ms on any UIPI-blocked press,
    // which violates the locked "honesty over illusion" decision. The whole press costs ~150ms;
    // waiting for truth is cheaper than lying briefly.
    const res = await winlang.setLayout(target);
    if (c.pendingTarget === target) c.pendingTarget = null;   // newer press owns it otherwise

    c.warnUntil = res.ok ? 0 : Date.now() + WARN_MS;
    this.repaint(ev.action);

    // The warn dot must expire on its own: poll() emits only on CHANGE, so with a static
    // foreground window nothing else would trigger the repaint that clears it.
    if (c.warnTimer) { clearTimeout(c.warnTimer); c.warnTimer = null; }
    if (!res.ok) {
      c.warnTimer = setTimeout(() => { c.warnTimer = null; this.repaint(ev.action); }, WARN_MS + 100);
      if (c.warnTimer.unref) c.warnTimer.unref();
    }
  }
}

const langKey = new LangKey();   // single instance: registered in main() AND repainted by the poll

function main() {
  // Its own persistent PowerShell — see winlang.js. Created here, but NOT started:
  // startWinLang() runs on the first onWillAppear so a user with no Language key placed pays
  // nothing (measured idle cost of an always-on co-process: ~67MB working set).
  winlang = createWinLang({ intervalMs: 1500, logger: streamDeck.logger });
  winlang.onChange(() => { for (const c of langContexts.values()) langKey.repaint(c.action); });
  // Without this the co-process outlives the plugin on every Stream Deck restart, and the 4x
  // import-retry loop would leave one orphan powershell.exe per attempt.
  process.on('exit', () => { try { winlang && winlang.stop(); } catch { /* shutting down */ } });

  streamDeck.actions.registerAction(langKey);
  streamDeck.connect();
}

try { main(); } catch (e) { try { streamDeck.logger.error(String(e)); } catch { /* pre-connect */ } throw e; }
