// Claude Deck — Stream Deck plugin entry (@elgato/streamdeck 2.x).
//
// Thin glue: it starts the hub (the brain), registers the two encoder actions, and
// forwards onDialRotate/onDialDown/onWillAppear into the tested action controller
// (action-logic.js). All behavior lives in the unit-tested modules; this file only
// binds the SDK. Its runtime is verified on hardware (#24) — `streamDeck.connect()`
// only works when launched by the Stream Deck app.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import sharp from 'sharp'; // native addon — kept external by esbuild, its binary copied by build.mjs
import { createRelayHub } from './relay-hub.js';
import { createDialAction } from './action-logic.js';
import { setEffort, defaultSettingsPath } from '../../patch/effort.js';
import { renderModelSvg, renderEffortSvg } from './render-lcd.js';
import { createCliHub } from './cli-hub.js';
import { pickCompactRoute } from './compact-router.js';
import { startForegroundPoller, foregroundInfo } from './foreground.js';
import { createWinLang } from './winlang.js';
import { orderLayouts, nextLayout, langFace } from './lang-logic.js';
import { renderLangSvg } from './render-lang.js';

// FALLBACK model catalog for Dial-1 browse. Since patch v3 the bridge snapshot carries
// the LIVE catalog (claudeConfig.models — exact .value vocabulary incl. [1m] variants)
// and relay-hub prefers it; this static list only covers a stale pre-v3 bridge. Bare
// slugs here may be rejected by the backend (near-miss trap — BRIDGE-PROTOCOL.md).
// Verified 2.1.209 first-party vocabulary (SDK initialize handshake against the
// extension's own CLI — values are aliases/suffixed slugs, NEVER bare current-gen slugs):
const CATALOG = [
  { value: 'default', label: 'Default (recommended)' },
  { value: 'opus[1m]', label: 'Opus' },
  { value: 'claude-fable-5[1m]', label: 'Fable' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
const CATALOG_LABEL = Object.fromEntries(CATALOG.map((m) => [m.value, m.label]));

// Composite the LCD as a single rasterized pixmap (see render-lcd.js / layouts/dial.json)
// so the physical device gets the same gradients/staircase the mockup previews, not just
// plain text. The chat-name header lives on the MODEL canvas only (full width, marquee
// when overflowing); the effort canvas is header-free.
async function pixmapFor(dial, ts, ui) {
  // Prefer the chat's real summary (its display name) over the raw sessionId.
  const chatLabel = ts.kind === 'ok'
    ? (ts.summary || ts.sessionId || '') : '';
  let svg;
  if (dial === 'model') {
    // resolve the real catalog label so the LCD shows "Opus 4.8", not a slug-derived
    // guess — live snapshot catalog first (exact labels for [1m] variants), static fallback
    const label = (v) => (ts.catalog || []).find((m) => m && m.value === v)?.label || CATALOG_LABEL[v];
    const tsL = ts.kind === 'ok' && !ts.modelLabel ? { ...ts, modelLabel: label(ts.model) } : ts;
    const showPick = ui.browseValue != null && ['browsing', 'applying', 'confirmed'].includes(ui.phase);
    const uiL = showPick ? { ...ui, browseLabel: label(ui.browseValue) } : ui;
    svg = renderModelSvg(tsL, uiL, chatLabel);
  } else {
    svg = renderEffortSvg(ts, ui);
  }
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

let hub = null;
const controllers = [];   // { dial, ctl } for result dispatch

class DialBase extends SingletonAction {
  constructor(dial, uuid) {
    super();
    this.manifestId = uuid;      // 2.x reads this to route events (no decorator needed)
    this.dial = dial;
    this.byContext = new Map();  // action instance id -> controller
  }

  controller(ev) {
    if (!this.byContext.has(ev.action.id)) {
      // Pixmap rasterization (sharp) is async, so rapid rotations resolve out of order and
      // land stale frames (the "flash back to the old model" bug). Tag each render with a
      // monotonic seq and only push the LATEST — drop any earlier render that resolves late.
      let renderSeq = 0;
      const ctl = createDialAction({
        dial: this.dial,
        hub,
        setFeedback: (fb) => {
          if (!fb._raw) return;
          const seq = ++renderSeq;
          pixmapFor(this.dial, fb._raw.targetState, fb._raw.ui)
            .then((canvas) => { if (seq === renderSeq) return ev.action.setFeedback({ canvas }); })
            .catch((e) => { try { streamDeck.logger.error(`pixmap render failed: ${e.message}`); } catch { /* pre-connect */ } });
        },
        setEffort: (level) => setEffort(defaultSettingsPath(), level),
      });
      this.byContext.set(ev.action.id, ctl);
      controllers.push({ dial: this.dial, ctl });
    }
    return this.byContext.get(ev.action.id);
  }

  async onWillAppear(ev) {
    await ev.action.setFeedbackLayout('layouts/dial.json');
    if (hub) this.controller(ev).onUpdate();
  }

  onDialRotate(ev) { if (hub) this.controller(ev).onRotate(ev.payload.ticks); }
  onDialDown(ev) { if (hub) this.controller(ev).onPress(ev.payload?.settings?.press); }
}

class ModelDial extends DialBase { constructor() { super('model', 'com.alisher.claude-deck.model'); } }
class EffortDial extends DialBase { constructor() { super('effort', 'com.alisher.claude-deck.effort'); } }

// --- Language-cycle key (#27) ------------------------------------------------------------
// The plugin's first Keypad action. Independent of the hub/bridge: it talks only to
// winlang.js, so a dead VS Code bridge has no effect on it and vice versa.
let winlang = null;
const langContexts = new Map();   // action.id -> { action, seq, warnUntil, pendingTarget }

const WARN_MS = 4000;

// Returns the data URI; it deliberately does NOT push to the device. The caller checks its
// sequence number and only then calls setImage — mirroring DialBase (plugin.js:80-82), which
// gates BEFORE setFeedback. Pushing inside this helper would make the guard dead code.
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
    this.manifestId = 'com.alisher.claude-deck.lang';  // 2.x routes on this (plugin.js:64)
  }

  // Per-CONTEXT state, keyed like DialBase.byContext (plugin.js:66). SingletonAction is ONE
  // instance shared by every placed key, so `this.renderSeq`/`this.warnUntil` on the class
  // would let a repaint of key B invalidate key A's in-flight render — leaving every key but
  // the last one permanently blank, and painting A's warn dot onto B.
  ctx(action) {
    if (!langContexts.has(action.id)) {
      langContexts.set(action.id, { action, seq: 0, warnUntil: 0, pendingTarget: null, warnTimer: null });
    }
    return langContexts.get(action.id);
  }

  // Stale-frame guard, same shape as DialBase (plugin.js:80-82): sharp is async, so a slow
  // render must never land after a newer one. The seq check happens BEFORE the push.
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
  const bridgeHub = createRelayHub({ catalog: CATALOG }); // synchronous object (relay-hub.js)
  const cliHub = createCliHub();
  startForegroundPoller();                                 // async cache — never blocks the press
  // Language key (#27): its own persistent PowerShell — see winlang.js for why this is NOT
  // folded into the foreground poller (that consolidation is #28). Created here, but NOT
  // started: startWinLang() runs on the first onWillAppear so a user with no Language key
  // placed pays nothing (measured idle cost of an always-on co-process: ~67MB working set).
  winlang = createWinLang({ intervalMs: 1500, logger: streamDeck.logger });
  winlang.onChange(() => { for (const c of langContexts.values()) langKey.repaint(c.action); });
  // Without this the co-process outlives the plugin on every Stream Deck restart, and the 4x
  // import-retry loop (memory trap §2) would leave one orphan powershell.exe per attempt.
  process.on('exit', () => { try { winlang && winlang.stop(); } catch { /* shutting down */ } });
  // Facade: a model-dial PRESS (op:'compact') routes to the foreground CLI session, else the
  // bridge, else a refusal. All other ops pass straight through to the bridge hub, unchanged.
  hub = {
    ...bridgeHub,
    sendToTarget: (cmd) => {
      if (cmd.op === 'compact') {
        const bs = bridgeHub.targetState();
        const route = pickCompactRoute({ fg: foregroundInfo(), cliMarkers: cliHub.liveMarkers(), bridgeActive: bs && bs.kind === 'ok' });
        if (route.via === 'cli') return cliHub.sendCompact(route.id);
        if (route.via === 'none') {
          for (const c of controllers) if (c.dial === 'model') c.ctl.onResult({ id: null, ok: false, error: 'no-claude' });
          return null;
        }
      }
      return bridgeHub.sendToTarget(cmd);
    },
  };
  // CLI compact results (ok:false busy/permission/unconfirmed) reach the model dial for LCD feedback.
  cliHub.onResult((r) => { for (const c of controllers) if (c.dial === 'model') c.ctl.onResult({ id: null, ok: r.ok, error: r.reason }); });
  // route command results (acks) back to the matching dials
  const RESULT_DIAL = {
    set_model: 'model', compact: 'model',
    enable_ultracode: 'effort', set_effort: 'effort', disable_ultracode: 'effort', toggle_thinking: 'effort',
  };
  hub.onResult((r) => {
    const dial = RESULT_DIAL[r.op] ?? null;
    for (const c of controllers) if (!dial || c.dial === dial) c.ctl.onResult(r);
  });
  // repaint on focus/state changes — but skip a dial the user is mid-interaction with,
  // so the live-state resync never clobbers an in-progress browse.
  setInterval(() => { for (const c of controllers) if (c.ctl.idle()) c.ctl.onUpdate(); }, 500);
  // animation clock: pushes successive frames for continuous states (compacting spinner).
  // tick() is a no-op unless the focused chat is busy, so this idles cheaply.
  setInterval(() => { for (const c of controllers) c.ctl.tick && c.ctl.tick(); }, 120);

  streamDeck.actions.registerAction(new ModelDial());
  streamDeck.actions.registerAction(new EffortDial());
  streamDeck.actions.registerAction(langKey);
  streamDeck.connect();
}

try { main(); } catch (e) { try { streamDeck.logger.error(String(e)); } catch { /* pre-connect */ } throw e; }
