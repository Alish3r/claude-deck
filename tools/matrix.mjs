// M2 verification matrix — an end-to-end harness composing the REAL merged modules:
//   mock-hub  <--http-->  host bridge (#4)  <--in-process postMessage-->  webview bridge (#5) x2
// One webview bridge per chat (A, B), each with its own fake Cf. Proves the full loop:
//   hub command -> transport poll -> host routes by sessionId -> webview drives its Cf ->
//   two-phase ack -> host relays -> hub. Closes the M1 #2 cross-chat isolation leftover
//   (M1 could only test one open panel).
//
// Exports the wiring for patch/integration.test.mjs; `node tools/matrix.mjs` prints a table.

import { startHub } from './mock-hub.mjs';
import { HttpTransport } from '../patch/host/transport.js';
import { createHostBridge } from '../patch/host/bridge.js';
import { createWebviewBridge } from '../patch/webview/bridge.js';

// --- fake preact-style signal + Cf (the webview view-model the bridge reads/drives) ---
export function signal(v) {
  const subs = new Set();
  return {
    get value() { return v; },
    set(nv) { v = nv; for (const f of [...subs]) f(nv); },
    subscribe(fn) { subs.add(fn); fn(v); return () => subs.delete(fn); },
  };
}
export function makeCf(o = {}) {
  return {
    sessionId: signal(o.sessionId), modelSelection: signal(o.model || 'claude-fable-5'),
    currentModelInfo: signal({ value: o.model || 'claude-fable-5', label: o.model || 'Fable' }),
    effortLevel: signal(o.effort || 'xhigh'), ultracodeEnabled: signal(false),
    thinkingLevelOverride: signal('off'), started: signal(true),
    claudeConfig: { models: [{ value: 'claude-fable-5', label: 'Fable' }, { value: 'claude-haiku-4-5', label: 'Haiku' }] },
    setModel(d) { this.modelSelection.set(d.value); this.currentModelInfo.set({ value: d.value, label: d.value }); return true; },
    setThinkingLevel(l) { this.thinkingLevelOverride.set(l); },
    enableUltracode() { this.ultracodeEnabled.set(true); },
  };
}

export const waitFor = async (pred, { timeoutMs = 1500, stepMs = 15 } = {}) => {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

// Compose the full loop for two chats A and B against a running hub.
export function wireTwoChats(hub, { windowId = 'win1' } = {}) {
  // both start at the SAME model so "only A changed" cleanly proves isolation
  const cfA = makeCf({ sessionId: 'A', model: 'claude-fable-5' });
  const cfB = makeCf({ sessionId: 'B', model: 'claude-fable-5' });

  const transport = new HttpTransport({ port: hub.port, windowId, waitMs: 500 });

  // webview bridges post to the host, which relays to the hub (webview -> host -> hub)
  let hostBridge; // forward ref
  const sync = (fn) => fn();
  const bridgeA = createWebviewBridge({ store: { activeSession: signal(cfA) }, post: (e) => hostBridge.relay(e), schedule: sync });
  const bridgeB = createWebviewBridge({ store: { activeSession: signal(cfB) }, post: (e) => hostBridge.relay(e), schedule: sync });

  // the manager: each panel's postMessage delivers the command to that chat's webview bridge
  const manager = {
    activeSessionId: 'A',
    sessionPanels: new Map([
      ['A', { webview: { postMessage: (m) => bridgeA.handleCommand(m) } }],
      ['B', { webview: { postMessage: (m) => bridgeB.handleCommand(m) } }],
    ]),
  };

  hostBridge = createHostBridge({ manager, transport, windowId, focus: () => ({ focused: true }) });
  bridgeA.attach(); bridgeB.attach();
  transport.startPolling((cmd) => hostBridge.handleCommand(cmd));

  return {
    hostBridge, transport, manager, cfA, cfB, bridgeA, bridgeB,
    close: () => transport.stop(),
  };
}

// --- runnable matrix (console evidence) ------------------------------------
async function runMatrix() {
  const hub = await startHub({ port: 0 });
  const w = wireTwoChats(hub);
  const rows = [];
  const record = (name, ok, detail = '') => rows.push({ name, ok, detail });

  // 1. cross-chat isolation: set_model on A must change A only, never B
  hub.enqueue('win1', { op: 'set_model', value: 'claude-haiku-4-5', sessionId: 'A', id: 1 });
  await waitFor(() => w.cfA.modelSelection.value === 'claude-haiku-4-5');
  record('cross-chat isolation (set_model A, B unchanged)',
    w.cfA.modelSelection.value === 'claude-haiku-4-5' && w.cfB.modelSelection.value === 'claude-fable-5',
    `A=${w.cfA.modelSelection.value} B=${w.cfB.modelSelection.value}`);

  // 2. confirmed ack reached the hub
  const conf = await waitFor(() => hub.events.find((e) => e.kind === 'result' && e.phase === 'confirmed' && e.id === 1));
  record('two-phase ack: confirmed relayed to hub', !!conf, conf ? `op=${conf.op}` : 'missing');

  // 3. focus report reaches the hub with the active session
  await w.hostBridge.reportFocus();
  const focus = await waitFor(() => hub.events.find((e) => e.type === 'focus'));
  record('focus report -> hub (activeSessionId)', !!focus && focus.activeSessionId === 'A', focus ? `active=${focus.activeSessionId}` : 'missing');

  // 4. enable_ultracode (dial "max") round-trip on B
  hub.enqueue('win1', { op: 'enable_ultracode', sessionId: 'B', id: 2 });
  const ultra = await waitFor(() => w.cfB.ultracodeEnabled.value === true);
  record('enable_ultracode (max) drives the addressed chat', !!ultra, `B.ultracode=${w.cfB.ultracodeEnabled.value}`);

  // 5. command to a disposed chat -> error, not a throw
  await w.hostBridge.disposePanel('B');
  hub.enqueue('win1', { op: 'set_model', value: 'claude-fable-5', sessionId: 'B', id: 3 });
  const err = await waitFor(() => hub.events.find((e) => e.type === 'result' && e.ok === false && e.sessionId === 'B'));
  record('command to disposed chat -> error result', !!err, err ? err.error : 'missing');

  w.close(); await hub.close();

  const pass = rows.filter((r) => r.ok).length;
  console.log('\nM2 verification matrix');
  console.log('----------------------');
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  console.log(`\n${pass}/${rows.length} scenarios passed`);
  process.exit(pass === rows.length ? 0 : 1);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/matrix.mjs')) {
  runMatrix();
}
