# claude-deck-patcher (companion extension)

A tiny VS Code extension that applies and maintains the Claude Deck bridge patch on the
Claude Code extension, and re-applies it after Claude Code auto-updates (which strip the
patch). The patcher's lockfile guarantees that across multiple VS Code windows **exactly
one** applies.

## What it does (on activate + on Claude Code update)

1. Locate the highest-version `anthropic.claude-code-*` extension.
2. Ask `logic.decideAction(status)`: pristine → **patch**, patched → **noop**, partial →
   **repair**, drift → **read-only**.
3. On patch: show a one-time **Reload window** prompt; update the status-bar health item
   (`active` / `reload to activate` / `partial (read-only)` / `patch broken`).
4. Commands: `Claude Deck: Re-apply bridge patch`, `Claude Deck: Revert bridge patch`.

The decision + health logic (`src/logic.mjs`) is pure and unit-tested
(`companion/logic.test.mjs`). The VS Code glue (`src/extension.js`) is thin.

## Live gated test (requires approval — not run in CI/`node --test`)

Activating this runs `patcher.apply()` against the **live** Claude Code extension. To
verify end-to-end (with a pristine backup already captured by the patcher):

1. Side-load in developer mode — symlink or copy `companion/` into the VS Code
   extensions dir (or `code --install-extension` a packaged `.vsix`), then reload.
2. On activation, confirm the status bar shows **"Claude Deck: reload to activate"** and a
   reload prompt appears; accept it.
3. After reload, confirm the bridge is live (host heartbeat, per the canary) and the
   status bar shows **"active"**.
4. Run **Claude Deck: Revert bridge patch** and confirm the extension is restored
   byte-identical to pristine (the patcher verifies this) and still loads.

`patch/cli.mjs status|verify|apply --guard|revert` is the CLI equivalent for manual runs.
