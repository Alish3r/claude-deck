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
import { orderLayouts, nextLayout, langFace, labelFor, normalizeHex, defaultBg } from './lang-logic.js';
import { renderLangSvg } from './render-lang.js';
import { createShutdown, installProcessHandlers } from './shutdown.js';

let winlang = null;
// action.id -> { action, seq, warnUntil, pendingTarget, warnTimer, colours }
// `colours` is the per-key override map from this action's settings (#36) — per CONTEXT, like
// everything else here, so two Language keys on one profile can hold different maps.
const langContexts = new Map();

const WARN_MS = 4000;

// Settings arrive from disk and from the property inspector, so they are untrusted: keep only
// entries that are a real language label mapped to a real hex colour. A garbage or partially
// garbage map degrades to "fewer overrides", never to a broken face.
function sanitizeColours(settings) {
  const raw = settings && typeof settings === 'object' ? settings.colours : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [label, value] of Object.entries(raw)) {
    const hex = normalizeHex(value);
    if (hex && /^[A-Z0-9]{2,3}$/.test(label)) out[label] = hex;
  }
  return Object.keys(out).length ? out : null;
}

// The languages ACTUALLY installed on this machine, in the same order the key cycles them.
// The PI cannot enumerate these itself — only the co-process can (GetKeyboardLayoutList), so
// the plugin pushes them (#36). Deduped: en-US + en-GB are two layouts but one "EN" swatch.
function detectedLanguages() {
  const s = winlang && winlang.getState();
  const ordered = orderLayouts(s && s.list, winlang && winlang.getPreload());
  const seen = [];
  for (const hkl of ordered) {
    const label = labelFor(hkl);
    if (label && !seen.includes(label)) seen.push(label);
  }
  return seen;
}

// Returns the data URI; it deliberately does NOT push to the device. The caller checks its
// sequence number and only then calls setImage — pushing inside this helper would make the
// stale-frame guard dead code.
async function langPng(face) {
  const svg = renderLangSvg(face);
  const png = await sharp(Buffer.from(svg), { density: 384 }).resize(144, 144).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

// streamDeck.ui.sendToPropertyInspector is the only sender in 2.1.0 (Action has no such
// method — see node_modules/@elgato/streamdeck/dist/plugin/ui.d.ts:47); it is a no-op unless
// a PI for this plugin is visible, so calling it unconditionally is safe.
function pushLanguages() {
  const languages = detectedLanguages();
  const defaults = {};
  for (const l of languages) defaults[l] = defaultBg(l);
  Promise.resolve(streamDeck.ui.sendToPropertyInspector({ event: 'languages', languages, defaults }))
    .catch((e) => { try { streamDeck.logger.error(`lang PI push failed: ${e.message}`); } catch { /* pre-connect */ } });
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
      langContexts.set(action.id, { action, seq: 0, warnUntil: 0, pendingTarget: null, warnTimer: null, colours: null });
    }
    return langContexts.get(action.id);
  }

  // Stale-frame guard: sharp is async, so a slow render must never land after a newer one.
  // The seq check happens BEFORE the push.
  repaint(action) {
    const c = this.ctx(action);
    const seq = ++c.seq;
    const face = langFace(winlang && winlang.getState(), c.warnUntil);
    face.colours = c.colours;   // per-key overrides, threaded through as data (render-lang.js)
    langPng(face)
      .then((uri) => { if (seq === c.seq) return action.setImage(uri); })
      .catch((e) => { try { streamDeck.logger.error(`lang paint failed: ${e.message}`); } catch { /* pre-connect */ } });
  }

  async onWillAppear(ev) {
    const c = this.ctx(ev.action);
    c.colours = sanitizeColours(ev.payload && ev.payload.settings);
    startWinLang();                    // lazy: nothing runs until a Language key is placed
    this.repaint(ev.action);
  }

  // Fires when the Stream Deck app pushes settings back — including right after the PI's
  // setSettings. This is what makes a colour change repaint IMMEDIATELY (#36).
  onDidReceiveSettings(ev) {
    const c = this.ctx(ev.action);
    c.colours = sanitizeColours(ev.payload && ev.payload.settings);
    this.repaint(ev.action);
  }

  // The PI asks (getLanguages) as well as being told here, because PropertyInspectorDidAppear
  // can land before the PI's own websocket has finished registering — the reply would go
  // nowhere and the user would see an empty list.
  onPropertyInspectorDidAppear(ev) {
    pushLanguages();
  }

  onSendToPlugin(ev) {
    const p = ev.payload;
    if (p && p.event === 'getLanguages') pushLanguages();
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
  winlang.onChange(() => {
    for (const c of langContexts.values()) langKey.repaint(c.action);
    // A language added/removed in Windows while the PI is open must show up without a plugin
    // change (#36); this also covers a PI opened before the co-process had read its first list.
    if (streamDeck.ui.action) pushLanguages();
  });

  // #34: process lifecycle. `process.on('exit')` alone (all this file had) fires only when the
  // process is ALREADY exiting, so it can never CAUSE one — on a dropped Stream Deck socket
  // langcycle simply ran forever, one zombie per restart, each holding an orphan powershell.exe.
  // shutdown.js gives the two layers: exit on connection-loss errors/signals, and unref'd
  // handles so a CLEAN close drains the loop by itself.
  const shutdown = createShutdown({
    log: (m) => { try { streamDeck.logger.info(m); } catch { /* pre-connect */ } },
  });
  installProcessHandlers(shutdown);
  shutdown.addCloser(() => { try { winlang && winlang.stop(); } catch { /* already dead */ } });
  // Kept as well: it still covers exits shutdown.run() does not drive (e.g. bootstrap.js's
  // import-retry path bailing out), and winlang.stop() is idempotent.
  process.on('exit', () => { try { winlang && winlang.stop(); } catch { /* shutting down */ } });

  streamDeck.actions.registerAction(langKey);
  streamDeck.connect();
}

try { main(); } catch (e) { try { streamDeck.logger.error(String(e)); } catch { /* pre-connect */ } throw e; }
