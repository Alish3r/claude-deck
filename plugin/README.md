# Claude Deck — Stream Deck plugin

Two encoder actions (Model, Effort) + a 200×100 LCD for the Stream Deck +, controlling
the focused Claude Code chat via the M2 backend.

## Structure

```
plugin/
├── manifest.json        # 2 Encoder actions + 1 Keypad action, SDKVersion 2, Node 20, Win10 (StreamDeckPlus = DeviceType 7)
├── layouts/dial.json    # 200×100 layout: title (marquee) / value / icon (glyph) / indicator (gauge)
├── src/
│   ├── plugin.js        # @elgato entry: starts the hub, registers actions, connect()
│   ├── arbiter.js       # focus arbitration (which window/chat the dials control)
│   ├── store.js         # per-session state cache + targetState()
│   ├── dial-control.js  # debounce + monotonic seq + in-flight/ack
│   ├── hub.js           # HTTP hub the VS Code windows poll (+ hub.json discovery)
│   ├── browse.js        # model (wrap) / effort (clamp) value stepping
│   ├── action-logic.js  # dial behavior: rotate→apply, press, LCD paint
│   ├── lcd.js           # render(dial, state, ui) → setFeedback payload
│   ├── winlang.js       # persistent PowerShell co-process (input-language read/write)
│   ├── lang-logic.js    # pure: HKL -> label/colour, Preload ordering, cycle wrap
│   └── render-lang.js   # render 72x72 language key face -> SVG
└── package.json         # @elgato/streamdeck ^2.x
```

Model dial → `hub.sendToTarget({op:'set_model'})` (routed to the focused chat). Effort
dial → **⊙GLOBAL** `settings.json` write locally; `max` also sends `enable_ultracode`.

## Language key (Windows only)

A Keypad action showing the current Windows input language; press cycles to the next installed
layout and wraps. Independent of the Claude bridge — it talks only to `winlang.js`.

- Switching uses `WM_INPUTLANGCHANGEREQUEST` posted to the foreground window (a documented API,
  not simulated keystrokes) and applies to that window only, matching native `Alt+Shift`.
- Cycle order follows `HKCU\Keyboard Layout\Preload`, falling back to numeric HKL sort.
- The face is correct **within 1.5s**, not instantly: an external switch (physical `Alt+Shift`,
  tray click, focus change) is picked up on the next poll.
- **Elevated windows:** Stream Deck runs non-elevated and Windows UIPI blocks `PostMessage` into
  elevated windows, so switching silently fails for admin apps. Detected via read-back mismatch
  and shown as a warn dot rather than a false language.

## Verified now (no hardware)

- All logic is unit-tested (`node --test`): arbiter, store, dial-control, hub (real http),
  LCD render, browse, action controller. `@elgato/streamdeck` 2.x imports resolve; manifest
  + layout are valid; `node --check` clean.

## Remaining — #24 (hardware-gated)

- **Image assets** under `imgs/` (plugin marketplace icon + per-action icon/key images) —
  referenced by the manifest; needed for the Stream Deck app to load the plugin.
- Package as `com.alisher.claude-deck.sdPlugin` + side-load via the `streamdeck` CLI.
- Boot on the device: `streamDeck.connect()` only works when launched by the Stream Deck app.
- End-to-end hardware checklist (focus→LCD, dial→change, presses, survives reload/update).
