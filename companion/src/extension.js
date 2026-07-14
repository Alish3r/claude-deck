// Claude Deck Patcher — VS Code glue (CommonJS extension).
//
// Thin wiring only: it feeds the patcher's status to the pure logic (logic.mjs) and
// renders the result — apply on activate/update, one reload prompt, a health status bar.
// The patcher's lockfile guarantees that across multiple windows exactly one applies.
//
// GATED: activating this runs patcher.apply() against the LIVE Claude Code extension.
// Its runtime behavior is verified in the live gated test (#7), not in `node --test`.
// The decision/health logic it relies on IS unit-tested (companion/logic.test.mjs).

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let statusBar;

// The patcher lives in the claude-deck repo. When installed into the VS Code extensions
// dir, `install.mjs` bakes the repo's absolute path into repo-path.json (sibling of this
// file's parent). Running from the repo (dev), fall back to the repo-relative location.
function repoRoot() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'repo-path.json'), 'utf8')).repo; }
  catch { return path.join(__dirname, '..', '..'); } // dev: companion/src -> repo root
}

// patch/* and logic.mjs are ESM; load them from this CJS module via dynamic import.
async function libs() {
  const patcher = await import(pathToFileURL(path.join(repoRoot(), 'patch', 'patcher.js')).href);
  const logic = await import(pathToFileURL(path.join(__dirname, 'logic.mjs')).href);
  return { patcher, logic };
}

async function renderHealth(patcher, logic, dir, opts = {}) {
  const st = patcher.status(dir);
  const h = logic.healthLabel(st, opts);
  statusBar.text = h.text;
  statusBar.tooltip = `Claude Deck bridge — ${h.state} (${dir})`;
  statusBar.show();
  return h;
}

async function ensurePatched() {
  const { patcher, logic } = await libs();

  let dir;
  try { dir = patcher.locateExtensionDir(); }
  catch { statusBar.text = '$(circle-slash) Claude Deck: no Claude Code extension'; statusBar.show(); return; }

  const decision = logic.decideAction(patcher.status(dir));
  if (decision.action === 'noop') { await renderHealth(patcher, logic, dir); return; }
  if (decision.action === 'read-only') { await renderHealth(patcher, logic, dir, { broken: true }); return; }

  // 'patch' or 'repair' — the lockfile ensures only one window actually applies.
  try {
    patcher.apply(dir);
    await renderHealth(patcher, logic, dir, { reloadPending: true });
    const pick = await vscode.window.showInformationMessage(
      'Claude Deck: bridge patched. Reload the window to activate it?', 'Reload', 'Later',
    );
    if (pick === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    const kind = logic.classifyApplyError(e.message);
    if (kind === 'locked') { await renderHealth(patcher, logic, dir); return; } // another window won the race
    await renderHealth(patcher, logic, dir, { broken: true }); // drift/syntax -> read-only
    vscode.window.showWarningMessage(`Claude Deck: could not patch (${kind}); running read-only. ${e.message}`);
  }
}

async function revert() {
  const { patcher } = await libs();
  const dir = patcher.locateExtensionDir();
  patcher.revert(dir);
  const pick = await vscode.window.showInformationMessage('Claude Deck: reverted to pristine. Reload to finish?', 'Reload');
  if (pick === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
}

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeDeck.repatch', ensurePatched),
    vscode.commands.registerCommand('claudeDeck.revert', revert),
    // re-patch when the Claude Code extension updates (auto-update strips the patch)
    vscode.extensions.onDidChange(() => ensurePatched()),
  );
  ensurePatched();
}

function deactivate() {}

module.exports = { activate, deactivate };
