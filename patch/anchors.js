// Single source of truth for the Claude Code bundle patch.
//
// Every transform is declared once here and consumed by BOTH the verifier and the
// applier (patcher.js), so a count check and the splice it guards can never drift.
// The payloads below are the M1-spike splices verbatim — proven `node --check`-clean
// and runtime-verified (see spike/M1-RESULTS.md). M2 issues #4/#5 swap these payloads
// for the real host/webview bridges; the engine and anchors are payload-agnostic.

export const MARK = '/*__CLAUDE_DECK_v1__*/';
export const PATCH_VERSION = 1;

// File paths relative to a located extension directory.
export const FILES = {
  host: 'extension.js',
  webview: 'webview/index.js',
};

// --- payloads (verbatim from the M1 spike) ---------------------------------

// Webview bridge IIFE. Memoizes acquireVsCodeApi, posts a hello on attach, exposes
// __cdAttach, and handles claudedeck_cmd (resync / set_model / set_effort).
const W_BRIDGE = `${MARK}(function(){try{if(globalThis.__cdAttach)return;var real=window.acquireVsCodeApi,api=null;if(real){window.acquireVsCodeApi=function(){return api||(api=real())};try{api=window.acquireVsCodeApi();globalThis.__cdApi=api}catch(e){}}var post=function(m){try{globalThis.__cdApi&&globalThis.__cdApi.postMessage(m)}catch(e){}};var cur=null;function val(s){try{return s&&typeof s.value!=="undefined"?s.value:void 0}catch(e){return void 0}}function snap(){try{var cf=cur;if(!cf)return;var mi=val(cf.currentModelInfo)||{};post({type:"claudedeck_evt",kind:"state",sessionId:val(cf.sessionId),modelOverride:val(cf.modelSelection),modelEffective:(mi&&(mi.value||mi.resolvedModel))||null,modelLabel:(mi&&mi.label)||null,effort:val(cf.effortLevel)||null,ultracode:val(cf.ultracodeEnabled)||false})}catch(e){}}globalThis.__cdAttach=function(store){try{globalThis.__cdStore=store;var bind=function(cf){if(!cf)return;cur=cf;try{["sessionId","modelSelection","currentModelInfo","effortLevel","ultracodeEnabled"].forEach(function(k){try{cf[k]&&cf[k].subscribe&&cf[k].subscribe(snap)}catch(e){}})}catch(e){}snap()};try{store.activeSession&&store.activeSession.subscribe&&store.activeSession.subscribe(bind)}catch(e){}try{bind(store.activeSession&&store.activeSession.value)}catch(e){}post({type:"claudedeck_evt",kind:"hello"})}catch(e){}};window.addEventListener("message",function(ev){try{var d=ev&&ev.data;if(!d||d.type!=="claudedeck_cmd")return;if(d.op==="resync"){snap();return}if(d.op==="set_model"&&cur&&cur.setModel){var r=cur.setModel({value:d.value});post({type:"claudedeck_evt",kind:"result",op:"set_model",requested:d.value,returned:(r===void 0?"undefined":String(r)),ok:true});setTimeout(snap,400)}else if(d.op==="set_effort"&&cur&&cur.setEffortLevel){var r2=cur.setEffortLevel(d.value);post({type:"claudedeck_evt",kind:"result",op:"set_effort",requested:d.value,returned:(r2===void 0?"undefined":String(r2)),ok:true});setTimeout(snap,600)}}catch(e){post({type:"claudedeck_evt",kind:"result",ok:false,error:String(e&&e.message||e)})}})}catch(e){}})();\n`;

// Host-side prepend: Node heartbeat + command-relay poller (cache-immune; the host
// bundle is require()'d fresh on window reload).
const H_PREPEND = `${MARK}try{globalThis.__cdWrite=function(n,d){try{var os=require("os"),fs=require("fs"),p=require("path");fs.writeFileSync(p.join(os.tmpdir(),n),JSON.stringify(d))}catch(e){}};globalThis.__cdWrite("claude-deck-host-alive.json",{via:"top",t:Date.now()});globalThis.__cdPoll=setInterval(function(){try{var os=require("os"),fs=require("fs"),p=require("path");var f=p.join(os.tmpdir(),"claude-deck-cmd.json");if(!fs.existsSync(f))return;var cmd=JSON.parse(fs.readFileSync(f,"utf8"));try{fs.unlinkSync(f)}catch(e){}var mgr=globalThis.__claudeDeck&&globalThis.__claudeDeck.mgr;if(!mgr){globalThis.__cdWrite("claude-deck-relayed.json",{err:"no mgr yet"});return}var sid=cmd.sessionId||mgr.activeSessionId;var panel=mgr.sessionPanels&&mgr.sessionPanels.get&&mgr.sessionPanels.get(sid);if(panel&&panel.webview){panel.webview.postMessage({type:"claudedeck_cmd",op:cmd.op,value:cmd.value});globalThis.__cdWrite("claude-deck-relayed.json",{ok:true,sid:sid,op:cmd.op,value:cmd.value,t:Date.now()})}else{globalThis.__cdWrite("claude-deck-relayed.json",{err:"no panel",sid:sid,active:mgr.activeSessionId,keys:(mgr.sessionPanels&&mgr.sessionPanels.size)})}}catch(e){try{globalThis.__cdWrite("claude-deck-relayed.json",{err:String(e&&e.message||e)})}catch(_){}}},500);}catch(e){}\n`;

// --- transforms -------------------------------------------------------------
// kind:'replace' — re must match exactly `count` times in the pristine file; the
//   apply() swaps every match via `replacement`.
// kind:'prepend' — payload is prepended to the file (no anchor).
// Order within a file matters only for `replace` steps; prepends are applied last.

export const STEPS = [
  // ---- webview (webview/index.js) ----
  {
    id: 'W-api', file: 'webview', kind: 'replace', count: 1,
    re: /([A-Za-z_$][\w$]*)=acquireVsCodeApi\(\)/,
    replacement: (m, v) => `${v}=(globalThis.__cdApi=acquireVsCodeApi())${MARK}`,
  },
  {
    id: 'W-store', file: 'webview', kind: 'replace', count: 1,
    re: /if\(([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\),window\.IS_SESSION_LIST_ONLY\)/,
    replacement: (m, app, ctor, a, c) =>
      `if(${app}=new ${ctor}(${a},${c}),${MARK}(globalThis.__cdAttach&&globalThis.__cdAttach(${app})),window.IS_SESSION_LIST_ONLY)`,
  },
  { id: 'W-bridge', file: 'webview', kind: 'prepend', payload: W_BRIDGE },

  // ---- host (extension.js) ----
  { id: 'H-prepend', file: 'host', kind: 'prepend', payload: H_PREPEND },
  {
    id: 'H-mgr', file: 'host', kind: 'replace', count: 1,
    re: /sessionPanels=new Map;sessionStates=new Map;activeSessionId/,
    replacement: (m) =>
      `${m}=(globalThis.__claudeDeck=globalThis.__claudeDeck||{},globalThis.__claudeDeck.mgr=this,globalThis.__cdWrite&&globalThis.__cdWrite("claude-deck-host-alive.json",{via:"mgr-ctor",t:Date.now()}),void 0)${MARK}`,
  },
  {
    id: 'H-msg', file: 'host', kind: 'replace', count: 3,
    re: /(this\.output\.info\(`Received message from webview: \$\{JSON\.stringify\(([A-Za-z_$][\w$]*)\)\}`\),)([A-Za-z_$][\w$]*)\?\.fromClient\(\2\)/g,
    replacement: (m, pre, msgVar, ctrlVar) =>
      `${pre}${MARK}(${msgVar}&&typeof ${msgVar}.type==="string"&&${msgVar}.type.indexOf("claudedeck")===0?(globalThis.__cdWrite&&globalThis.__cdWrite(${msgVar}.kind==="result"?"claude-deck-result.json":${msgVar}.kind==="state"?("claude-deck-state-"+(${msgVar}.sessionId||"x")+".json"):"claude-deck-webview-alive.json",${msgVar})):${ctrlVar}?.fromClient(${msgVar}))`,
  },
];

// Spatial anchors verified but not spliced — their presence proves the bundle shape
// the bridge relies on hasn't drifted.
export const VERIFY_ONLY = [
  {
    id: 'Cf-signal-block', file: 'webview', count: 1,
    re: /modelSelection=lt\(void 0\);currentMainLoopModel=lt\(void 0\);lastServedModel=lt\(void 0\);fastModeState=lt\("off"\);analyticsDisabled=lt\(!1\);effortLevel=lt\(void 0\);ultracodeEnabled=lt\(!1\)/,
  },
  { id: 'store-activeSession', file: 'webview', count: 1, re: /activeSession=lt\(void 0\)/ },
];

// Count non-overlapping matches of `re` in `src` (g-flag safe).
export function countMatches(src, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let n = 0;
  while (g.exec(src) !== null) { n++; if (g.lastIndex === 0) break; }
  return n;
}
