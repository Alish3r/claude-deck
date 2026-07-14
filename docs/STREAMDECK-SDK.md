# Stream Deck SDK — verified facts for M3 (the plugin)

_Verified 2026-07-14 against the live Elgato docs (links at bottom). Supersedes the second-hand SDK line in `PLAN.md` where they differ._

The plugin is a **real, native Stream Deck plugin**: it installs into the Stream Deck app, its two encoder actions appear in the actions list, and you drag them onto the Stream Deck + dials. For personal use it's **side-loaded in developer mode** (an unpacked `<uuid>.sdPlugin` bundle linked into the plugins folder via the `streamdeck` CLI) — no Marketplace submission and no code signing required. (Marketplace/signing only matter for public distribution, which is explicitly out of scope.)

## Confirmed (matches the plan)

- **LCD/touch strip canvas is exactly 200 × 100 px.** Items outside these bounds are not rendered. `background` art: 200×100 (@1x) and 400×200 (@2x), PNG/SVG.
- **Layout item types:** `text`, `pixmap`, `bar`, `gbar` (gradient bar). `setFeedback` updates items by their `key` — string values for text/pixmap, numeric for bar/gbar.
- **Feedback layout:** `setFeedbackLayout(layout)` takes a built-in id (`$A0 $A1 $B1 $B2 $C1 $X1`) or a relative path to a custom `.json` layout.
- **Encoder actions:** an action declares `Controllers: ["Encoder"]` (optionally `["Keypad","Encoder"]`) with an `Encoder` object (`layout`, `TriggerDescription {Push, Rotate, Touch, LongTouch}`, `background`).
- **Encoder events** via `@elgato/streamdeck` `SingletonAction`: `onDialRotate` (rotation, carries ticks + pressed), `onDialDown`, `onDialUp`, `onTouchTap` (carries `tapPos` + hold/long-touch). `action.isDial()` runtime-checks encoder support.
- **Library:** `@elgato/streamdeck` (Node). Plugin runs as a Node child process of the Stream Deck app, talking to it over the app's WebSocket — our own 127.0.0.1 hub for the VS Code side is separate and fine.

## Updated / new vs the plan

- **Node runtime:** manifest `Nodejs.Version` accepts **`"20"` or `"24"`**, both documented as supported with no flagged issue. The plan's "avoid 24" caution appears **stale** — treat as re-test-before-trusting, not a hard rule. Default to `"20"` unless a dep needs 24.
- **`Software.MinimumVersion`:** accepts a range **`6.4`–`7.4`**. `6.6` (plan's value) is valid; pick the lowest that has the encoder/LCD APIs we use.
- **`SDKVersion`:** new to note — accepts `2 | 3`, **`3` recommended**. Use 3.
- **OS mins:** `OS: [{Platform:"windows"|"mac", MinimumVersion}]` — Windows 10 is a valid min (our target).

## Still to verify before M3 build

- **Stream Deck + device identity:** the plan says `device.type === 7`. Not confirmed on the dials/manifest pages — verify against the WebSocket `deviceDidConnect` device-type table before relying on it.
- Exact `dialRotate` payload field names (`ticks`, `pressed`) — the `@elgato/streamdeck` typed event exposes them; confirm names when wiring `onDialRotate`.

## Where this lands in our design (per PLAN.md M3)

Two `SingletonAction` encoder actions (`model-dial`, `effort-dial`) in `plugin/`, a 200×100 custom `dial.json` layout (marquee + value + glyph + gauge), `setFeedback` on state change, the 127.0.0.1 WS hub for focus arbitration + host routing. Dial 2 renders the ⊙GLOBAL effort (see `BRIDGE-PROTOCOL.md`).

## Sources

- [Dials & Touch Strip guide](https://docs.elgato.com/streamdeck/sdk/guides/dials/)
- [Manifest reference](https://docs.elgato.com/streamdeck/sdk/references/manifest/)
- [Getting Started](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/)
- [Plugin WebSocket reference](https://docs.elgato.com/streamdeck/sdk/references/websocket/plugin/)
