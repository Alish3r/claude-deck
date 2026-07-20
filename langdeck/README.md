# Lang Cycle — Stream Deck plugin

A single Keypad action that shows the current **Windows input language** and cycles to the
next installed layout on press. Windows only.

Its own plugin (`com.alisher.langcycle`), deliberately separate from Claude Deck: the two
share no code, no UUID and no build, so deploying one never disturbs the other (#29).

## Structure

```
langdeck/
├── manifest.json        # 1 Keypad action, SDKVersion 2, Node 20, Win10
├── build.mjs            # esbuild bundle -> .sdPlugin (icons, sharp closure, EXPECT check)
├── src/
│   ├── bootstrap.js     # crash-handler entry (CodePath) — logs import failures
│   ├── plugin.js        # @elgato entry: registers the Language action, connect()
│   ├── winlang.js       # persistent PowerShell co-process (input-language read/write)
│   ├── lang-logic.js    # pure: HKL -> label/colour, Preload ordering, cycle wrap
│   └── render-lang.js   # render 72x72 language key face -> SVG
├── ui/
│   └── inspector.html   # property inspector: per-language colour pickers (no build step)
└── package.json         # @elgato/streamdeck ^2.x
```

## Behavior

- Switching uses `WM_INPUTLANGCHANGEREQUEST` posted to the foreground window (a documented API,
  not simulated keystrokes) and applies to that window only, matching native `Alt+Shift`.
- Cycle order follows `HKCU\Keyboard Layout\Preload`, falling back to numeric HKL sort.
- The face is correct **within 1.5s**, not instantly: an external switch (physical `Alt+Shift`,
  tray click, focus change) is picked up on the next poll.
- **Colours** default to EN slate `#1e3a5f`, RU clay `#d97757`, everything else the neutral
  `#141518`. The property inspector lists the languages the plugin actually detected on this
  machine and lets you override the background per language, stored per key — two Language keys
  can differ. Text colour is derived from the chosen background for contrast, not configured.
- **Elevated windows:** Stream Deck runs non-elevated and Windows UIPI blocks `PostMessage` into
  elevated windows, so switching silently fails for admin apps. Detected via read-back mismatch
  and shown as a warn dot rather than a false language.

## Build

```
cd langdeck
npm install
node build.mjs --no-install   # stage only
node build.mjs                # stage + side-load into the Stream Deck Plugins dir
npx @elgato/cli restart com.alisher.langcycle
```

## Tests

```
cd langdeck && node --test    # lang-logic, render-lang, winlang (fake child process)
```
