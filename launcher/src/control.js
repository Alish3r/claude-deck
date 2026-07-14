// launcher/src/control.js — pure command router. Given a command + the current idle state,
// produce a SUBMIT PLAN or a refusal. Idle-gate is mandatory: only 'idle' proceeds. Claude's Ink
// input treats an injected \r fused with text as a newline (claude-code#15553), so the plan is:
// literal text, SETTLE, then a separate Enter — and the bin VERIFIES compaction started before ok.
export function planCommand(cmd, idleState) {
  const base = { op: cmd.op, id: cmd.id };
  if (cmd.op !== 'compact') return { refuse: true, steps: [], result: { ...base, ok: false, reason: 'unsupported' } };
  if (idleState !== 'idle') return { refuse: true, steps: [], result: { ...base, ok: false, reason: idleState } };
  return { refuse: false, steps: [{ text: '/compact' }, { settleMs: 350 }, { text: '\r' }], verify: true, result: { ...base, ok: true } };
}
