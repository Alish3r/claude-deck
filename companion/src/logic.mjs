// Pure companion decision + health logic (NO vscode, NO fs) — unit-testable.
// The VS Code glue (extension.js) feeds it a patcher `status` object and renders the
// result into a reload prompt + status-bar item.

// Given the current patch status, decide what the companion should do on activate/update.
export function decideAction(status) {
  if (status.broken) return { action: 'read-only', reason: 'anchors drifted — degrade to read-only' };
  if (status.patched) return { action: 'noop', reason: 'already patched (current)' };
  if (status.partial) return { action: 'repair', reason: 'partial patch — re-apply atomically' };
  return { action: 'patch', reason: 'pristine — apply the bridge' };
}

// Status-bar presentation. `reloadPending` = patched this session, awaiting a reload to
// activate; `broken` = anchors drifted / apply failed (read-only). Uses VS Code
// `$(icon)` codicons in the text.
export function healthLabel(status, { reloadPending = false, broken = false } = {}) {
  if (broken || status.broken) return { state: 'broken', text: '$(error) Claude Deck: patch broken (read-only)' };
  if (status.partial) return { state: 'read-only', text: '$(warning) Claude Deck: partial patch (read-only)' };
  if (status.patched && reloadPending) return { state: 'reload-needed', text: '$(sync) Claude Deck: reload to activate' };
  if (status.patched) return { state: 'patched', text: '$(check) Claude Deck: active' };
  return { state: 'pristine', text: '$(circle-slash) Claude Deck: not patched' };
}

// Classify an apply() error so the glue can pick the right degraded state.
export function classifyApplyError(message) {
  const m = String(message || '');
  if (/patch in progress/i.test(m)) return 'locked';   // another window is patching — back off, not broken
  if (/anchor/i.test(m)) return 'anchors';              // drift — read-only/broken
  if (/node --check/i.test(m)) return 'syntax';         // patched bundle wouldn't parse — broken
  return 'other';
}
