// Claude Deck — Stream Deck plugin entry (@elgato/streamdeck 2.x).
//
// Thin glue: it starts the hub (the brain), registers the two encoder actions, and
// forwards onDialRotate/onDialDown/onWillAppear into the tested action controller
// (action-logic.js). All behavior lives in the unit-tested modules; this file only
// binds the SDK. Its runtime is verified on hardware (#24) — `streamDeck.connect()`
// only works when launched by the Stream Deck app.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { createHub } from './hub.js';
import { createDialAction } from './action-logic.js';
import { setEffort, defaultSettingsPath } from '../../patch/effort.js';

const HUB_PORT = 28710; // fixed loopback port; the VS Code host-inject reads hub.json
let hub = null;
const controllers = [];   // { dial, ctl } for result dispatch

// The layout's `icon` item is text — map the semantic glyph state to a character.
const GLYPH = { idle: '', spinner: '◐', ok: '✓', warn: '!' };
const withGlyph = (fb) => ({ ...fb, icon: GLYPH[fb.icon] ?? '' });

class DialBase extends SingletonAction {
  constructor(dial, uuid) {
    super();
    this.manifestId = uuid;      // 2.x reads this to route events (no decorator needed)
    this.dial = dial;
    this.byContext = new Map();  // action instance id -> controller
  }

  controller(ev) {
    if (!this.byContext.has(ev.action.id)) {
      const ctl = createDialAction({
        dial: this.dial,
        hub,
        setFeedback: (fb) => ev.action.setFeedback(withGlyph(fb)),
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
  onDialDown(ev) { if (hub) this.controller(ev).onPress(); }
}

class ModelDial extends DialBase { constructor() { super('model', 'com.alisher.claude-deck.model'); } }
class EffortDial extends DialBase { constructor() { super('effort', 'com.alisher.claude-deck.effort'); } }

async function main() {
  hub = await createHub({ port: HUB_PORT });
  // route command results (acks) back to the matching dials
  hub.onResult((r) => {
    const dial = r.op === 'set_model' ? 'model' : r.op === 'enable_ultracode' ? 'effort' : null;
    for (const c of controllers) if (!dial || c.dial === dial) c.ctl.onResult(r);
  });
  // repaint on focus/state changes (cheap; controllers keep their own browse state)
  setInterval(() => { for (const c of controllers) c.ctl.onUpdate(); }, 400);

  streamDeck.actions.registerAction(new ModelDial());
  streamDeck.actions.registerAction(new EffortDial());
  streamDeck.connect();
}

main().catch((e) => { try { streamDeck.logger.error(String(e)); } catch { /* pre-connect */ } });
