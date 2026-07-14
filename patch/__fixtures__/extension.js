// Synthetic host-bundle fixture — NOT Anthropic code. Hand-authored to carry the
// exact patch anchors (H-mgr ×1, H-msg ×3) inside minimal valid JS, so the patch
// engine can be unit-tested without the proprietary extension bundle.
class Manager {
  sessionPanels=new Map;sessionStates=new Map;activeSessionId;
  wireA(){ this.pA?.webview?.onDidReceiveMessage?.((a)=>{this.output.info(`Received message from webview: ${JSON.stringify(a)}`),s?.fromClient(a)}); }
  wireB(){ this.pB?.webview?.onDidReceiveMessage?.((b)=>{this.output.info(`Received message from webview: ${JSON.stringify(b)}`),t?.fromClient(b)}); }
  wireC(){ this.pC?.webview?.onDidReceiveMessage?.((c)=>{this.output.info(`Received message from webview: ${JSON.stringify(c)}`),u?.fromClient(c)}); }
}
globalThis.__fixtureManager = Manager;
