// Synthetic webview-bundle fixture — NOT Anthropic code. Hand-authored to carry the
// exact patch anchors (W-api ×1, W-store ×1) and the verify-only spatial anchors
// (Cf signal block, store.activeSession) inside minimal valid JS.
class Cf {
  modelSelection=lt(void 0);currentMainLoopModel=lt(void 0);lastServedModel=lt(void 0);fastModeState=lt("off");analyticsDisabled=lt(!1);effortLevel=lt(void 0);ultracodeEnabled=lt(!1);
}
class Store { activeSession=lt(void 0); }
function boot() {
  let e=acquireVsCodeApi();
  let l, a, c;
  if(l=new zG(a,c),window.IS_SESSION_LIST_ONLY){}
  return { Cf, Store, e };
}
globalThis.__fixtureBoot = boot;
