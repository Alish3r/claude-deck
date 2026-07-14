// Single source of truth for the Claude Code bundle patch.
//
// Every transform is declared once here and consumed by BOTH the verifier and the
// applier (patcher.js), so a count check and the splice it guards can never drift.
// The payloads below are the M1-spike splices verbatim — proven `node --check`-clean
// and runtime-verified (see spike/M1-RESULTS.md). M2 issues #4/#5 swap these payloads
// for the real host/webview bridges; the engine and anchors are payload-agnostic.

export const MARK = '/*__CLAUDE_DECK_v1__*/'; // marker unchanged so existing patches still revert
export const PATCH_VERSION = 9; // v9: snapshot reads currentMainLoopModel (the REAL running model) not modelSelection (the stale picker); maps it to a catalog descriptor for label + browse anchor. v8: compact via cur.send. v7: activeSessionId tab-switch tracking. v6: relay resolvedModel. v5: set_effort mirror. v4: per-cmd/per-result files, atomic writes, active-tab stamp.

// File paths relative to a located extension directory.
export const FILES = {
  host: 'extension.js',
  webview: 'webview/index.js',
};

// --- payloads (verbatim from the M1 spike) ---------------------------------

// Webview bridge IIFE (v3). Captures Cf incl. summary + busy; rebinds on chat switch;
// handles resync / set_model / toggle_thinking / enable_ultracode / compact. All reads
// and method calls are guarded (missing signals/methods fail safe).
// v3: snapshots carry the LIVE model catalog (claudeConfig.value.models → {value,label
// from displayName}) and set_model drives the chat exactly as the picker does — full
// descriptor looked up by value (the live setModel forwards the whole object to the
// backend, which rejects-and-rolls-back unknown ones while the method still returns —
// the bare-{value} spike call acked ok:true yet never changed the model). The result
// event now settles from the returned promise (ok:false on rollback/rejection).
const W_BRIDGE = `${MARK}(function(){try{if(globalThis.__cdAttach)return;var real=window.acquireVsCodeApi,api=null;if(real){window.acquireVsCodeApi=function(){return api||(api=real())};try{api=window.acquireVsCodeApi();globalThis.__cdApi=api}catch(e){}}var post=function(m){try{globalThis.__cdApi&&globalThis.__cdApi.postMessage(m)}catch(e){}};var cur=null;function val(s){try{return s&&typeof s.value!=="undefined"?s.value:void 0}catch(e){return void 0}}function snap(){try{var cf=cur;if(!cf)return;var mi=val(cf.currentModelInfo)||{};var cc=val(cf.claudeConfig)||{};var cat=[];try{var ms=cc.models||[];for(var ci=0;ci<ms.length;ci++){var mm=ms[ci];if(mm&&mm.value)cat.push({value:mm.value,label:mm.displayName||mm.label||null,resolved:mm.resolvedModel||null})}}catch(e){}var mll=val(cf.currentMainLoopModel)||null;var sel=val(cf.modelSelection);var real=mll||(mi&&(mi.resolvedModel||mi.value))||sel||null;var actDesc=null,actAlt=null;for(var ai=0;ai<cat.length;ai++){var cd=cat[ai];if(!cd)continue;if(cd.resolved===real||cd.value===real){if(cd.value==="default"){if(!actAlt)actAlt=cd}else{actDesc=cd;break}}}actDesc=actDesc||actAlt;post({type:"claudedeck_evt",kind:"state",sessionId:val(cf.sessionId),modelOverride:sel,modelSelDefault:(sel==="default"||!sel),modelEffective:real,modelResolved:real,modelActive:(actDesc&&actDesc.value)||null,modelLabel:(actDesc&&actDesc.label)||(mi&&(mi.label||mi.displayName))||null,effort:val(cf.effortLevel)||null,ultracode:val(cf.ultracodeEnabled)||false,thinking:val(cf.thinkingLevelOverride)||null,summary:val(cf.summary)||null,busy:val(cf.busy)||false,catalog:cat})}catch(e){}}var unsubs=[];globalThis.__cdAttach=function(store){try{globalThis.__cdStore=store;var bind=function(cf){if(!cf||cf===cur)return;cur=cf;for(var ui=0;ui<unsubs.length;ui++){try{unsubs[ui]()}catch(e){}}unsubs=[];try{["sessionId","modelSelection","currentModelInfo","effortLevel","ultracodeEnabled","thinkingLevelOverride","summary","busy","claudeConfig"].forEach(function(k){try{if(cf[k]&&cf[k].subscribe){var un=cf[k].subscribe(snap);if(typeof un==="function")unsubs.push(un)}}catch(e){}})}catch(e){}snap()};try{store.activeSession&&store.activeSession.subscribe&&store.activeSession.subscribe(function(){bind(val(store.activeSession))})}catch(e){}try{bind(val(store.activeSession))}catch(e){}post({type:"claudedeck_evt",kind:"hello"})}catch(e){}};window.addEventListener("message",function(ev){try{var d=ev&&ev.data;if(!d||d.type!=="claudedeck_cmd")return;if(d.op==="resync"){snap();return}if(d.op==="set_model"&&cur&&cur.setModel){var cc2=val(cur.claudeConfig)||{};var ls=cc2.models||[];var hit=null;for(var li=0;li<ls.length;li++){if(ls[li]&&ls[li].value===d.value){hit=ls[li];break}}if(!hit){post({type:"claudedeck_evt",kind:"result",op:"set_model",requested:d.value,ok:false,error:"not-in-catalog",id:d.id})}else{try{Promise.resolve(cur.setModel(hit)).then(function(rr){post({type:"claudedeck_evt",kind:"result",op:"set_model",requested:d.value,returned:rr,ok:rr!==false,id:d.id});snap()},function(er){post({type:"claudedeck_evt",kind:"result",op:"set_model",requested:d.value,ok:false,error:String(er&&er.message||er),id:d.id});snap()})}catch(e2){post({type:"claudedeck_evt",kind:"result",op:"set_model",requested:d.value,ok:false,error:String(e2&&e2.message||e2),id:d.id})}setTimeout(snap,300)}}else if(d.op==="toggle_thinking"&&cur&&cur.setThinkingLevel){var tl=(val(cur.thinkingLevelOverride)==="default_on")?"off":"default_on";cur.setThinkingLevel(tl);post({type:"claudedeck_evt",kind:"result",op:"toggle_thinking",ok:true,id:d.id});setTimeout(snap,300)}else if(d.op==="enable_ultracode"&&cur&&cur.enableUltracode){cur.enableUltracode();post({type:"claudedeck_evt",kind:"result",op:"enable_ultracode",ok:true,id:d.id});setTimeout(snap,300)}else if((d.op==="set_effort"||d.op==="disable_ultracode")&&cur&&cur.setEffortLevel){cur.setEffortLevel(d.value==null?void 0:d.value);post({type:"claudedeck_evt",kind:"result",op:d.op,ok:true,id:d.id});setTimeout(snap,300)}else if(d.op==="compact"&&cur&&cur.send){try{Promise.resolve(cur.send("/compact")).catch(function(){})}catch(e){}post({type:"claudedeck_evt",kind:"result",op:"compact",ok:true,id:d.id});setTimeout(snap,150)}else{post({type:"claudedeck_evt",kind:"result",op:d.op,ok:false,error:"unhandled",id:d.id})}}catch(e){post({type:"claudedeck_evt",kind:"result",ok:false,error:String(e&&e.message||e)})}})}catch(e){}})();\n`;

// Host-side prepend (v7): per-COMMAND files + per-RESULT files + atomic writes + liveness
// + ACTIVE-TAB TRACKING. The poller watches mgr.activeSessionId; when it changes (the user
// switched chat tabs within the window — which fires NO webview signal, so neither chat
// would otherwise re-snap), it resyncs BOTH the leaving and entering chats so each
// re-stamps its per-session `active` flag and the relay retargets to the tab now in view.
// Each host gets a random windowId and polls claude-deck-cmd-<wid>-*.json (one file per
// command, written atomically by the plugin via tmp+rename, consumed in filename order).
// Claiming is unlink-FIRST: a command is dispatched only after its file was successfully
// unlinked — at-most-once semantics, no replay of non-idempotent ops (compact) when an
// unlink transiently fails. The legacy single-mailbox claude-deck-cmd-<wid>.json is still
// drained (upgrade compat). Undeliverable commands (no manager yet / panel gone) write an
// ok:false result with the command id instead of vanishing; each dispatch is individually
// try/caught so one bad panel can't abort the rest of the queue. Results are written to
// UNIQUE files (claude-deck-res-<wid>-<seq>.json, via the H-msg splice) so concurrent
// acks never overwrite each other. __cdWrite is atomic (tmp+rename) — readers never see
// a torn file. Every ~2s the poller stamps claude-deck-alive-<wid>.json so the plugin can
// tell dead windows' stale state files from live ones. __cdFocused() exposes
// vscode.window.state.focused for the H-msg focus stamp; window-focus changes re-resync
// the active panel. All require() + vscode access is guarded (fails safe).
// IIFE-wrapped: the prepend shares the bundle's CJS module scope, and the minified bundle
// declares its own top-level `var fs` (esbuild lazy-init) and assigns `pp=` (Zod) — with
// bare `var` names the bindings merge and the bundle's assignments clobber the fs/path
// modules out from under every bridge closure (poller, __cdWrite) while the heartbeat,
// written before the bundle body runs, still fires. Own scope = zero collision surface.
const H_PREPEND = `${MARK}(function(){try{var os=require("os"),fs=require("fs"),pp=require("path");var WID=Math.random().toString(36).slice(2,10);globalThis.__cdWID=WID;globalThis.__cdWrite=function(n,d){try{var p=pp.join(os.tmpdir(),n);fs.writeFileSync(p+".tmp",JSON.stringify(d));fs.renameSync(p+".tmp",p)}catch(e){}};globalThis.__cdFocused=function(){try{return require("vscode").window.state.focused}catch(e){return false}};globalThis.__cdWrite("claude-deck-host-alive.json",{via:"top",wid:WID,t:Date.now()});var dispatch=function(cmd){try{var mgr=globalThis.__claudeDeck&&globalThis.__claudeDeck.mgr;if(!mgr){globalThis.__cdWrite("claude-deck-res-"+WID+"-"+(globalThis.__cdResSeq=(globalThis.__cdResSeq||0)+1)+".json",{type:"claudedeck_evt",kind:"result",op:cmd.op,ok:false,error:"no-mgr",id:cmd.id});return}var sid=cmd.sessionId||mgr.activeSessionId;var panel=mgr.sessionPanels&&mgr.sessionPanels.get&&mgr.sessionPanels.get(sid);if(panel&&panel.webview){panel.webview.postMessage({type:"claudedeck_cmd",op:cmd.op,value:cmd.value,id:cmd.id})}else{globalThis.__cdWrite("claude-deck-res-"+WID+"-"+(globalThis.__cdResSeq=(globalThis.__cdResSeq||0)+1)+".json",{type:"claudedeck_evt",kind:"result",op:cmd.op,ok:false,error:"no-panel",id:cmd.id})}}catch(e){}};globalThis.__cdTick=0;globalThis.__cdPoll=setInterval(function(){try{globalThis.__cdTick++;if(globalThis.__cdTick%6===0){globalThis.__cdWrite("claude-deck-alive-"+WID+".json",{t:Date.now()})}var mgrA=globalThis.__claudeDeck&&globalThis.__claudeDeck.mgr;if(mgrA&&mgrA.sessionPanels&&mgrA.sessionPanels.get){var curA=mgrA.activeSessionId;if(curA!==globalThis.__cdLastActive){var prevA=globalThis.__cdLastActive;globalThis.__cdLastActive=curA;[prevA,curA].forEach(function(sid){try{var pnl=sid&&mgrA.sessionPanels.get(sid);if(pnl&&pnl.webview)pnl.webview.postMessage({type:"claudedeck_cmd",op:"resync"})}catch(e){}})}}var dir=os.tmpdir();var pre="claude-deck-cmd-"+WID+"-";var names=[];try{var all=fs.readdirSync(dir);for(var ni=0;ni<all.length;ni++){if(all[ni].indexOf(pre)===0&&all[ni].slice(-5)===".json")names.push(all[ni])}}catch(e){}names.sort();for(var qi=0;qi<names.length;qi++){var full=pp.join(dir,names[qi]);var cmd;try{cmd=JSON.parse(fs.readFileSync(full,"utf8"))}catch(e){continue}try{fs.unlinkSync(full)}catch(e){continue}dispatch(cmd||{})}var legacy=pp.join(dir,"claude-deck-cmd-"+WID+".json");if(fs.existsSync(legacy)){var parsed=null;try{parsed=JSON.parse(fs.readFileSync(legacy,"utf8"))}catch(e){}if(parsed!==null){try{fs.unlinkSync(legacy)}catch(e){parsed=null}if(parsed!==null){var cmds=Array.isArray(parsed)?parsed:[parsed];for(var li=0;li<cmds.length;li++)dispatch(cmds[li]||{})}}}}catch(e){}},350);try{require("vscode").window.onDidChangeWindowState(function(){try{var mgr=globalThis.__claudeDeck&&globalThis.__claudeDeck.mgr;if(mgr&&mgr.sessionPanels&&mgr.activeSessionId){var pnl=mgr.sessionPanels.get(mgr.activeSessionId);if(pnl&&pnl.webview)pnl.webview.postMessage({type:"claudedeck_cmd",op:"resync"})}}catch(e){}})}catch(e){}}catch(e){}})();\n`;

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
    // Results get UNIQUE filenames (concurrent acks never overwrite); state snapshots are
    // stamped with windowId + window focus + ACTIVE (is this the window's active tab?) —
    // focus alone is window-level, so with 2+ chats in one window the busiest background
    // chat would otherwise win the newest-focused-state race and hijack the dials.
    replacement: (m, pre, msgVar, ctrlVar) =>
      `${pre}${MARK}(${msgVar}&&typeof ${msgVar}.type==="string"&&${msgVar}.type.indexOf("claudedeck")===0?(globalThis.__cdWrite&&globalThis.__cdWrite(${msgVar}.kind==="result"?("claude-deck-res-"+globalThis.__cdWID+"-"+(globalThis.__cdResSeq=(globalThis.__cdResSeq||0)+1)+".json"):${msgVar}.kind==="state"?("claude-deck-state-"+(${msgVar}.sessionId||"x")+".json"):"claude-deck-webview-alive.json",${msgVar}.kind==="state"?Object.assign({},${msgVar},{windowId:globalThis.__cdWID,focused:!!(globalThis.__cdFocused&&globalThis.__cdFocused()),active:(globalThis.__claudeDeck&&globalThis.__claudeDeck.mgr?globalThis.__claudeDeck.mgr.activeSessionId===${msgVar}.sessionId:null)}):${msgVar})):${ctrlVar}?.fromClient(${msgVar}))`,
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
