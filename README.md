# Claude Deck

Stream Deck + hardware dials controlling the **Claude Code VS Code extension's native webview chats**:

- **Dial 1 — model** (per-chat: the focused chat tab, across multiple VS Code windows)
- **Dial 2 — effort** (⊙GLOBAL — proven to be a global setting, see below)

The extension exposes no public API for model/effort, so this works via a **local, reversible patch** of the extension bundles (host + webview bridge) plus a Stream Deck plugin/hub. Unsupported local mod — **do not distribute patched files**.

## Status

**M1 de-risk spike PASSED (2026-07-13) — GO for M2.** All existential gates (bundle loads, CSP permits the bridge, host↔webview round-trip, per-chat model write, live read, effort-scope verdict) proven on the live extension with disk evidence.

- 📋 [docs/STATUS.md](docs/STATUS.md) — current state, verified machine state, next steps
- 📐 [docs/PLAN.md](docs/PLAN.md) — approved V3 plan (M1–M4, two audit rounds, locked decisions)
- 🔌 [docs/BRIDGE-PROTOCOL.md](docs/BRIDGE-PROTOCOL.md) — spike bridge message/file protocol + measured hazards
- 🧪 [spike/M1-RESULTS.md](spike/M1-RESULTS.md) — gate-by-gate evidence log

## Layout

```text
claude-deck/
├── docs/        # plan, status, protocol (start here)
├── spike/       # M1 evidence: pristine/patched bundle copies, anchor verifier, test logs, settings baseline
├── patch/       # (M2) patcher engine: anchors, csp, host-inject, webview-bridge, cli.mjs apply|revert|status|verify
├── companion/   # (M2) "claude-deck-patcher" VS Code extension — patch-runner only
├── plugin/      # (M3) Stream Deck plugin: 2 encoder actions, LCD, WS hub, focus arbitration
├── shared/      # (M2) protocol types + patch-version constant
└── tools/       # (M2) mock-hub.mjs
```

## Key facts (byte-/runtime-verified on v2.1.207)

- Per-chat view-model `Cf` methods: `setModel(desc)`, `setEffortLevel(level)`, `setThinkingLevel`, `enableUltracode()`; signals are preact `.subscribe()`-able.
- Model is **per-channel** (`set_model` by channelId) → per-chat dial works.
- Effort is **GLOBAL** (`~/.claude/settings.json:effortLevel`); `setEffortLevel`'s ack can lie (executed but not persisted) → closed-loop writes; the webview effort signal tracks neither in-app nor external changes.
- Effort enum: `low|medium|high|xhigh`; "max" = `enableUltracode()`; "Auto" = unset.
- Hidden webview panels add ~2 s message latency; timers are throttled.

## Reverting the live patch

```sh
cp spike/pristine/extension.js  ~/.vscode/extensions/anthropic.claude-code-2.1.207-win32-x64/extension.js
cp spike/pristine/index.js      ~/.vscode/extensions/anthropic.claude-code-2.1.207-win32-x64/webview/index.js
```

then **Developer: Reload Window**. (An extension auto-update also silently removes the patch.)
