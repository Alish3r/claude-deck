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
import { startForegroundPoller, stopForegroundPoller, foregroundInfo } from './foreground.js';
import { createShutdown, installProcessHandlers } from './shutdown.js';

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

function main() {
  // #30: every long-lived handle is registered here so a dropped Stream Deck socket tears
  // the process down instead of leaving a zombie holding the bundle's sharp DLLs.
  const shutdown = createShutdown({
    log: (m) => { try { streamDeck.logger.info(m); } catch { /* pre-connect */ } },
  });
  installProcessHandlers(shutdown);

  const bridgeHub = createRelayHub({ catalog: CATALOG }); // synchronous object (relay-hub.js)
  const cliHub = createCliHub();
  shutdown.addCloser(() => bridgeHub._stop?.());           // relay result poller
  shutdown.addCloser(() => cliHub._stop?.());              // cli-hub result poller
  // async cache — never blocks the press. The logger is forwarded so the co-process's
  // respawn/timeout diagnostics reach the Stream Deck log instead of nowhere.
  shutdown.addTimer(startForegroundPoller({ logger: streamDeck.logger }));
  shutdown.addCloser(() => stopForegroundPoller());        // #28: kills the foreground co-process
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
  shutdown.addTimer(setInterval(() => { for (const c of controllers) if (c.ctl.idle()) c.ctl.onUpdate(); }, 500));
  // animation clock: pushes successive frames for continuous states (compacting spinner).
  // tick() is a no-op unless the focused chat is busy, so this idles cheaply.
  shutdown.addTimer(setInterval(() => { for (const c of controllers) c.ctl.tick && c.ctl.tick(); }, 120));
  // The HTTP hub (src/hub.js) is not instantiated on this path — the plugin talks to the
  // bridge over the file relay. Registered defensively so it is closed if it is ever wired
  // in, since a listening server is exactly the kind of handle that pins the event loop.
  shutdown.addCloser(() => hub && hub.close && hub.close());

  streamDeck.actions.registerAction(new ModelDial());
  streamDeck.actions.registerAction(new EffortDial());
  streamDeck.connect();
}

try { main(); } catch (e) { try { streamDeck.logger.error(String(e)); } catch { /* pre-connect */ } throw e; }
