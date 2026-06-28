const fs = require('fs');
const path = require('path');
const { resolveMainJsPath } = require('../../paths');

const REVIEW_BRIDGE_MARKER = '__cursorPoolRelayReviewBridge_v5';
const REVIEW_BRIDGE_MARKER_FAMILY_REGEX = /__cursorPoolRelayReviewBridge(?:_v\d+)?/;
const REVIEW_BRIDGE_EFFECT_ANCHOR = '},[a,V,t,i]);const Be=di(()=>{';
const INLINE_DIFF_SERVICE_ANCHOR = 'this._userPlansDir=fV(this.pathService.userHome({preferLocal:!0})),this.experimentService.checkFeatureGate("inline_diffs_v2_adapter")';
const INLINE_DIFF_SERVICE_ANCHOR_VARIANT = 'this._userPlansDir=UV(this.pathService.userHome({preferLocal:!0}));for(const D of edn.registeredActions)D(this.reactiveStorageService);';
const INLINE_DIFF_SERVICE_DELAYED_REGISTRATION = 'Yi(xF,i8a,1)';
const INLINE_DIFF_SERVICE_EAGER_REGISTRATION = 'Yi(xF,i8a,0)';
const REVIEW_EVENTS_PATH = '/__cursorpool__/review-events';
const REVIEW_BRIDGE_DEBUG_PATH = '/__cursorpool__/review-bridge-debug';
const REVIEW_ACTIONS_PATH = '/__cursorpool__/review-actions';
const REVIEW_EVENTS_DEFAULT_PORT = Number(process.env.CURSOR_RELAY_PORT || 17789);

// Cursor >=2026.06 ships `C=xs()` in the edit tool renderer; older builds need us to inject it.
const REVIEW_BRIDGE_SIGNATURE_VARIANTS = [
  {
    id: 'legacy',
    unpatched: 'const S=lHg(e),E=aym(v),I=di(()=>y==="edit"&&a$g(t),[t,y]),R=',
    patched: `const S=lHg(e),E=aym(v),${buildRelayReviewBridgeInjection()}`,
  },
  {
    id: 'native-c',
    unpatched: 'const S=lHg(e),E=aym(v),C=xs(),I=di(()=>y==="edit"&&a$g(t),[t,y]),R=',
    patched: 'const S=lHg(e),E=aym(v),C=xs(),I=di(()=>y==="edit"&&a$g(t),[t,y]),R=',
  },
];

function resolveWorkbenchDesktopMainJsPath(explicitMainJsPath) {
  const mainJsPath = explicitMainJsPath || resolveMainJsPath();
  if (!mainJsPath) return null;
  const candidate = path.join(path.dirname(mainJsPath), 'vs', 'workbench', 'workbench.desktop.main.js');
  return fs.existsSync(candidate) ? candidate : null;
}

function hasRelayReviewBridgePatch(text) {
  return String(text || '').includes(REVIEW_BRIDGE_MARKER);
}

function hasAnyRelayReviewBridgePatch(text) {
  return REVIEW_BRIDGE_MARKER_FAMILY_REGEX.test(String(text || ''));
}

function findReviewBridgeSignatureVariant(text) {
  const source = String(text || '');
  for (const variant of REVIEW_BRIDGE_SIGNATURE_VARIANTS) {
    if (source.includes(variant.unpatched)) {
      return { variant, needsSignaturePatch: variant.unpatched !== variant.patched };
    }
    if (source.includes(variant.patched) && variant.unpatched !== variant.patched) {
      return { variant, needsSignaturePatch: false, signatureAlreadyPatched: true };
    }
  }
  return null;
}

function applyReviewBridgeSignaturePatch(text, variant) {
  if (!variant || variant.unpatched === variant.patched) return text;
  return String(text || '').replace(variant.unpatched, variant.patched);
}

function restoreReviewBridgeSignaturePatch(text) {
  let restored = String(text || '');
  for (const variant of REVIEW_BRIDGE_SIGNATURE_VARIANTS) {
    if (variant.unpatched === variant.patched) continue;
    restored = restored.replace(variant.patched, variant.unpatched);
  }
  return restored;
}

function restoreRelayReviewBridgePatchedText(text) {
  let restored = restoreReviewBridgeSignaturePatch(String(text || ''));
  restored = restored.replace(INLINE_DIFF_SERVICE_EAGER_REGISTRATION, INLINE_DIFF_SERVICE_DELAYED_REGISTRATION);
  restored = restored.replace(
    /\},\[a,V,t,i\]\);[\s\S]*?globalThis\.__cursorPoolRelayReviewBridge(?:_v\d+)?[\s\S]*?const Be=di\(\(\)=>\{/,
    REVIEW_BRIDGE_EFFECT_ANCHOR,
  );
  restored = restored.replace(
    /this\._userPlansDir=fV\(this\.pathService\.userHome\(\{preferLocal:!0\}\)\),\(\(Ye,Xe\)=>\{[\s\S]*?globalThis\.__cursorPoolRelayReviewBridge(?:_v\d+)?[\s\S]*?\}\)\(this,Xe\),this\.experimentService\.checkFeatureGate\("inline_diffs_v2_adapter"\)/,
    INLINE_DIFF_SERVICE_ANCHOR,
  );
  restored = restored.replace(
    /this\._userPlansDir=UV\(this\.pathService\.userHome\(\{preferLocal:!0\}\)\);\(\(Ye,Xe\)=>\{[\s\S]*?globalThis\.__cursorPoolRelayReviewBridge(?:_v\d+)?[\s\S]*?\}\)\(this,De\),for\(const D of edn\.registeredActions\)D\(this\.reactiveStorageService\);/,
    INLINE_DIFF_SERVICE_ANCHOR_VARIANT,
  );
  return restored;
}

function buildRelayReviewBridgeInjection() {
  return [
    'C=xs(),',
    'I=di(()=>y==="edit"&&a$g(t),[t,y]),R=',
  ].join('');
}

function buildRelayReviewBridgeEffect() {
  return [
    'Kd(()=>{',
    'try{',
    `const Ze=globalThis.${REVIEW_BRIDGE_MARKER}||(globalThis.${REVIEW_BRIDGE_MARKER}={entries:new Map(),pendingKeys:new Set(),lastSeq:0,pollTimer:0,pollBusy:!1,pollStarted:!1,debugLastError:"",debugEnabled:!0});`,
    'const ht=C?.inlineDiffService,vt=C?.cmdKStateService;',
    `const bt=()=>{const Ye=[];const Xe=Number(globalThis.process?.env?.CURSOR_RELAY_PORT)||0;Xe>0&&Ye.push(Xe);Ye.push(${REVIEW_EVENTS_DEFAULT_PORT});return Array.from(new Set(Ye.filter(dt=>Number(dt)>0))).map(dt=>\`http://127.0.0.1:\${dt}${REVIEW_EVENTS_PATH}\`)};`,
    `const Et=()=>{const Ye=[];const Xe=Number(globalThis.process?.env?.CURSOR_RELAY_PORT)||0;Xe>0&&Ye.push(Xe);Ye.push(${REVIEW_EVENTS_DEFAULT_PORT});return Array.from(new Set(Ye.filter(dt=>Number(dt)>0))).map(dt=>\`http://127.0.0.1:\${dt}${REVIEW_BRIDGE_DEBUG_PATH}\`)};`,
    `const It=()=>{const Ye=[];const Xe=Number(globalThis.process?.env?.CURSOR_RELAY_PORT)||0;Xe>0&&Ye.push(Xe);Ye.push(${REVIEW_EVENTS_DEFAULT_PORT});return Array.from(new Set(Ye.filter(dt=>Number(dt)>0))).map(dt=>\`http://127.0.0.1:\${dt}${REVIEW_ACTIONS_PATH}\`)};`,
    'const Nt=(Ye,Xe,dt)=>{',
    'if(Ze.debugEnabled===!1)return Promise.resolve(null);',
    'const ht2={type:String(Ye||"unknown"),detail:String(Xe||""),requestId:String(dt?.requestId||dt?.requestID||""),data:dt&&typeof dt=="object"?dt:null};',
    'const vt2=Et();',
    'const tt2=ut=>{if(ut>=vt2.length)return Promise.resolve(null);return Promise.resolve(fetch(vt2[ut],{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(ht2),cache:"no-store"})).catch(()=>tt2(ut+1))};',
    'return Promise.resolve(tt2(0)).catch(()=>null)',
    '};',
    'const At=(Ye,Xe)=>{const dt={action:String(Ye||""),...(Xe&&typeof Xe=="object"?Xe:{})},ht2=It(),vt2=ut=>{if(ut>=ht2.length)return Promise.resolve(null);return Promise.resolve(fetch(ht2[ut],{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(dt),cache:"no-store"})).then(ot=>ot?.ok?ot.json():null).catch(()=>vt2(ut+1))};return Promise.resolve(vt2(0)).catch(()=>null)',
    '};',
    'const Rt=()=>{try{const Ye=C?.workspaceContextService?.getWorkspace?.(),Xe=Ye?.folders?.[0]?.uri;if(!Xe)return "";if(String(Xe.scheme||"")==="file"){const dt=String(Xe.fsPath||"").trim();if(dt)return dt;return decodeURIComponent(String(Xe.path||"").replace(/^\\/([a-zA-Z]:)/,"$1"))}return String(Xe.fsPath||Xe.path||"").trim()}catch{return ""}};',
    'const St=Ye=>{try{const Xe=Rt(),dt=String(Ye?.workspaceRoot||"").trim(),ht2=String(Ye?.filePath||Ye?.path||"").trim();if(!Xe)return !dt;const vt2=tt2=>String(tt2||"").replace(/\\\\/g,"/").replace(/^file:\\/\\//i,"").replace(/^\\/([a-zA-Z]:)/,"$1").replace(/\\/+$/,"").toLowerCase(),tt2=vt2(Xe),rt2=vt2(dt),ut=vt2(ht2);const ot=!rt2||rt2===tt2||rt2.endsWith("/"+tt2)||tt2.endsWith("/"+rt2),lt2=!ut||ut===tt2||ut.startsWith(tt2+"/")||ut.startsWith(rt2+"/");if(ot&&lt2)return !0;Nt("review_event_workspace_skipped",`eventRoot=${dt||"-"} windowRoot=${Xe||"-"}`,{requestId:String(Ye?.requestId||""),workspaceRoot:Xe,eventWorkspaceRoot:dt,filePath:ht2});return !1}catch{return !0}};',
    'const kt=()=>{',
    'if(Ze.pollBusy)return;',
    'Ze.pollBusy=!0;',
    'const Qt=Rt();',
    'if(String(Ze.workspaceRoot||"")!==String(Qt||"")){Ze.workspaceRoot=String(Qt||"");Ze.lastSeq=0}',
    'Nt("poll_start",`after=${Number(Ze.lastSeq)||0} workspaceRoot=${Qt||"-"}`,{lastSeq:Number(Ze.lastSeq)||0,workspaceRoot:Qt});',
    'St2();',
    'const Ye=bt();',
    'const Jt=encodeURIComponent(Qt||"");',
    'const Xe=(dt=>{if(dt>=Ye.length)return Promise.resolve(null);return Promise.resolve(fetch(`${Ye[dt]}?after=${Number(Ze.lastSeq)||0}${Jt?`&workspaceRoot=${Jt}`:""}`,{cache:"no-store"})).then(ht2=>ht2?.ok?ht2.json():null).catch(()=>Xe(dt+1))})(0);',
    'Promise.resolve(Xe).then(dt=>{',
    'const ht2=Array.isArray(dt?.events)?dt.events:[];',
    'Nt("poll_success",`events=${ht2.length}`,{lastSeq:Number(dt?.lastSeq)||0,count:ht2.length});',
    'const ut2=[];',
    'for(const vt2 of ht2){if(!St(vt2))continue;const tt2=Number(vt2?.seq)||0;Nt("review_event_received",`seq=${tt2} file=${String(vt2?.filePath||vt2?.path||"")}`,{requestId:String(vt2?.requestId||""),seq:tt2,filePath:String(vt2?.filePath||vt2?.path||"")});ut2.push(Promise.resolve(ft(vt2)).then(rt2=>{if(rt2){tt2>Number(Ze.lastSeq||0)&&(Ze.lastSeq=tt2);Nt("review_event_attached",`seq=${tt2} diffId=${String(rt2||"")}`,{requestId:String(vt2?.requestId||""),seq:tt2,diffId:String(rt2||"")})}else{Nt("review_event_attach_pending",`seq=${tt2}`,{requestId:String(vt2?.requestId||""),seq:tt2})}}).catch(rt2=>Nt("review_event_attach_error",String(rt2?.message||rt2||"attach_failed"),{requestId:String(vt2?.requestId||""),seq:tt2})))}',
    'return Promise.allSettled(ut2).then(()=>{if(ut2.length===0){const rt2=Number(dt?.lastSeq)||0;rt2>Number(Ze.lastSeq||0)&&(Ze.lastSeq=rt2)}});',
    '}).catch(dt=>{Ze.debugLastError=String(dt?.message||dt||"poll_failed");Nt("poll_error",Ze.debugLastError,{message:Ze.debugLastError})}).finally(()=>{Ze.pollBusy=!1})',
    '};',
    'if(!Ze.pollStarted){',
    'Ze.pollStarted=!0;',
    'Nt("poll_boot","review bridge polling started",{pollIntervalMs:1500,hasInlineDiffService:Boolean(ht),hasCmdKStateService:Boolean(vt)});',
    'kt();',
    'Ze.pollTimer=setInterval(kt,1500);',
    '}',
    'if(!ht){Nt("inline_diff_unavailable","inlineDiffService missing",{hasCmdKStateService:Boolean(vt)});return;}',
    'if(!Ze.acceptRejectHooked){Ze.acceptRejectHooked=!0;try{typeof ht.onDidAcceptDiff=="function"&&ht.onDidAcceptDiff(Ye=>{try{const Xe=String(Ye?.diffId||"").trim();if(!Xe)return;const dt=[...Ze.entries.values()].find(ht2=>String(ht2?.diffId||"").trim()===Xe);Nt("native_accept",`diffId=${Xe}`,{diffId:Xe,requestId:String(dt?.requestId||""),filePath:String(dt?.filePath||dt?.uri||"")});At("accept",{diffId:Xe,requestId:String(dt?.requestId||""),filePath:String(dt?.filePath||dt?.uri||"")})}catch(dt){Nt("native_accept_error",String(dt?.message||dt||"accept_failed"),{message:String(dt?.message||dt||"accept_failed")})}}),typeof ht.onDidRejectDiff=="function"&&ht.onDidRejectDiff(Ye=>{try{const Xe=String(Ye?.diffId||"").trim();if(!Xe)return;const dt=[...Ze.entries.values()].find(ht2=>String(ht2?.diffId||"").trim()===Xe);Nt("native_reject",`diffId=${Xe}`,{diffId:Xe,requestId:String(dt?.requestId||""),filePath:String(dt?.filePath||dt?.uri||"")});At("reject",{diffId:Xe,requestId:String(dt?.requestId||""),filePath:String(dt?.filePath||dt?.uri||"")})}catch(dt){Nt("native_reject_error",String(dt?.message||dt||"reject_failed"),{message:String(dt?.message||dt||"reject_failed")})}})}catch(Ye){Nt("accept_reject_hook_error",String(Ye?.message||Ye||"hook_failed"),{message:String(Ye?.message||Ye||"hook_failed")})}}',
    'const tt=Ye=>{',
    'try{',
    'if(/^file:\\/\\//i.test(Ye))return xt.parse(Ye);',
    'if(/^[a-zA-Z]:[\\\\/]|^\\//.test(Ye))return typeof xt.file==="function"?xt.file(Ye):xt.parse(Ye);',
    'const Xe=C?.workspaceContextService?.getWorkspace?.(),dt=Xe?.folders?.[0]?.uri;',
    'if(!dt)return null;',
    'const ht2=String(Ye).replace(/\\\\/g,"/").replace(/^\\.\\//,""),vt2=ht2.split("/").filter(Boolean);',
    'if(typeof xt.joinPath==="function")return xt.joinPath(dt,...vt2);',
    'return typeof dt.with==="function"?dt.with({path:(String(dt.path||"").replace(/\\/$/,"")+"/"+ht2).replace(/\\/+/g,"/")}):null;',
    '}catch{return null}',
    '};',
    'const ot=()=>Array.isArray(ht?.inlineDiffs?.value)?ht.inlineDiffs.value:Array.isArray(ht?.inlineDiffs?.nonReactive?.())?ht.inlineDiffs.nonReactive():Array.isArray(ht?.inlineDiffs)?ht.inlineDiffs:[];',
    'const lt=Ye=>ot().find(Xe=>Xe&&Xe.id===Ye);',
    'const mt=(Ye,Xe)=>ot().find(dt=>dt&&String(dt.uri||"")===Ye&&(!Xe||dt.id!==Xe));',
    'const bt2=Ye=>{',
    'const Xe=String(Ye?.composerId||Ye?.cursorConversation?.composerId||"").trim();',
    'if(Xe)return Xe;',
    'const dt=ht?.composerDataService?.allComposersData;',
    'const ht2=Array.isArray(dt?.selectedComposerIds)?dt.selectedComposerIds.filter(Boolean):[];',
    'const vt2=Array.isArray(dt?.lastFocusedComposerIds)?dt.lastFocusedComposerIds.filter(Boolean):[];',
    'return String(vt2.find(tt2=>ht2.includes(tt2))||vt2[vt2.length-1]||ht2[ht2.length-1]||"").trim()',
    '};',
    'const Et2=Ye=>{',
    'const Xe=bt2(Ye);',
    'if(!Xe)return void 0;',
    'const dt=String(Ye?.toolCallId||Ye?.requestId||`relay-${Date.now().toString(36)}`).trim();',
    'return {composerId:Xe,toolCallId:dt,composerGenerationID:String(Ye?.requestId||dt)}',
    '};',
    'const gt=Ye=>{',
    'const Xe=Array.isArray(Ye)?Ye:[];',
    'let dt=1/0,ht2=0;',
    'for(const vt2 of Xe){',
    'const tt2=Math.max(1,Number(vt2?.removedLinesOriginalRange?.startLineNumber)||Number(vt2?.addedRange?.startLineNumber)||1);',
    'const Ye2=Math.max(tt2+1,Number(vt2?.removedLinesOriginalRange?.endLineNumberExclusive)||Number(vt2?.addedRange?.endLineNumberExclusive)||tt2+1);',
    'tt2<dt&&(dt=tt2);',
    'Ye2>ht2&&(ht2=Ye2);',
    '}',
    'return Number.isFinite(dt)&&ht2>0?{startLineNumber:dt,endLineNumberExclusive:ht2}:null;',
    '};',
    'const ct=Ye=>{',
    'if(Ye?.syncTimer){clearInterval(Ye.syncTimer);Ye.syncTimer=0}',
    'if(Ye?.stopTimer){clearTimeout(Ye.stopTimer);Ye.stopTimer=0}',
    '};',
    'const bt3=Ye=>({selections:Array.isArray(Ye?.selections)?Ye.selections:[],selectedDocs:Array.isArray(Ye?.selectedDocs)?Ye.selectedDocs:[],selectedCommits:Array.isArray(Ye?.selectedCommits)?Ye.selectedCommits:[],selectedLinks:Array.isArray(Ye?.selectedLinks)?Ye.selectedLinks:[],externalLinks:Array.isArray(Ye?.externalLinks)?Ye.externalLinks:[],images:Array.isArray(Ye?.images)?Ye.images:[],selectedImages:Array.isArray(Ye?.selectedImages)?Ye.selectedImages:[],fileSelections:Array.isArray(Ye?.fileSelections)?Ye.fileSelections:[],folderSelections:Array.isArray(Ye?.folderSelections)?Ye.folderSelections:[],terminalSelections:Array.isArray(Ye?.terminalSelections)?Ye.terminalSelections:[],terminalFiles:Array.isArray(Ye?.terminalFiles)?Ye.terminalFiles:[],selectedPullRequests:Array.isArray(Ye?.selectedPullRequests)?Ye.selectedPullRequests:[],composers:Array.isArray(Ye?.composers)?Ye.composers:[],cursorRules:Array.isArray(Ye?.cursorRules)?Ye.cursorRules:[],cursorCommands:Array.isArray(Ye?.cursorCommands)?Ye.cursorCommands:[],gitPRDiffSelections:Array.isArray(Ye?.gitPRDiffSelections)?Ye.gitPRDiffSelections:[],subagentSelections:Array.isArray(Ye?.subagentSelections)?Ye.subagentSelections:[],browserSelections:Array.isArray(Ye?.browserSelections)?Ye.browserSelections:[],extraContext:Array.isArray(Ye?.extraContext)?Ye.extraContext:[],initText:String(Ye?.initText||"")});',
    'const wt=Ye=>{',
    'try{',
    'const Xe=String(Ye||"").trim();',
    'if(!Xe||!vt||typeof vt.getPromptBars!="function")return;',
    'const dt=Array.isArray(vt.getPromptBars?.())?vt.getPromptBars():[];',
    'for(const ht2 of dt){',
    'if(!ht2||String(ht2.diffId||"")!==Xe)continue;',
    'vt.updatePromptBar?.(ht2.id,"diffId",void 0);',
    'ht2.currentRangeDecorationId&&vt.updatePromptBar?.(ht2.id,"currentRangeDecorationId",void 0);',
    '}',
    '}catch{}',
    '};',
    'const St2=()=>{',
    'for(const [Ye,Xe] of Ze.entries){',
    'const dt=String(Xe?.diffId||"").trim();',
    'if(!dt||lt(dt))continue;',
    'ct(Xe);',
    'wt(dt);',
    'Ze.entries.delete(Ye);',
    'Nt("stale_diff_cleared",`diffId=${dt}`,{diffId:dt,uri:String(Xe?.uri||"")});',
    '}',
    '};',
    'const yt=(Ye,Xe)=>{',
    'try{',
    'if(typeof vt.addPromptBar!="function")return null;',
    'const dt=Array.isArray(vt.getPromptBars?.())?vt.getPromptBars():[];',
    'const ht2=dt.length?dt[dt.length-1]:null;',
    'const vt2=`relay-promptbar:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,8)}`;',
    'const tt2={...(ht2&&typeof ht2=="object"?ht2:{}),id:vt2,uri:Ye,diffId:void 0,currentRangeDecorationId:void 0,visible:!0,generating:!1,data:bt3(ht2?.data),height:Number(ht2?.height)||40,indentColumn:Math.max(1,Number(Xe?.startLineNumber)||1),forceRerenderInputBox:(Number(ht2?.forceRerenderInputBox)||0)+1,queryHistory:ht2?.queryHistory,chatResponse:ht2?.chatResponse,inlineChatHistory:ht2?.inlineChatHistory,previousStructuredTextsNewestFirst:Array.isArray(ht2?.previousStructuredTextsNewestFirst)?ht2.previousStructuredTextsNewestFirst:[],modifyTextModelPrePromptBarForwardEdit:Array.isArray(ht2?.modifyTextModelPrePromptBarForwardEdit)?ht2.modifyTextModelPrePromptBarForwardEdit:[],modifyTextModelPrePromptBarBackwardEdit:Array.isArray(ht2?.modifyTextModelPrePromptBarBackwardEdit)?ht2.modifyTextModelPrePromptBarBackwardEdit:[],prePromptBarCursorPosition:ht2?.prePromptBarCursorPosition,createdAt:Date.now()};',
    'vt.addPromptBar(tt2);',
    'Nt("promptbar_created",`uri=${String(Ye||"")}`,{uri:String(Ye||""),promptBarId:vt2});',
    'return tt2;',
    '}catch(Ye2){Nt("promptbar_create_error",String(Ye2?.message||Ye2||"promptbar_create_failed"),{message:String(Ye2?.message||Ye2||"promptbar_create_failed")});return null}',
    '};',
    'const at=(Ye,Xe)=>{',
    'if(!vt||typeof vt.getPromptBars!="function")return null;',
    'const dt=vt.getPromptBars?.()??[];',
    'for(let ht2=dt.length-1;ht2>=0;ht2--){const vt2=dt[ht2];if(vt2&&vt2.visible!==!1&&String(vt2.uri||"")===Ye){vt2.data=bt3(vt2.data);return vt2}}',
    'for(let ht2=dt.length-1;ht2>=0;ht2--){const vt2=dt[ht2];if(vt2&&vt2.visible!==!1&&!vt2.diffId){vt2.data=bt3(vt2.data);return vt2}}',
    'return dt.length?dt[dt.length-1]:yt(Ye,Xe)',
    '};',
    'const pt=(Ye,Xe,dt)=>{',
    'if(!dt)return;',
    'const ht2=Array.isArray(vt.getPromptBars?.())?vt.getPromptBars():[];',
    'const vt2=lt(dt);',
    'if(!vt2){ct(Xe);wt(String(dt||""));Ze.entries.delete(Ye);return}',
    'const tt2=vt2.currentRange||gt(vt2.changes)||{startLineNumber:1,endLineNumberExclusive:(Array.isArray(vt2.newTextLines)?vt2.newTextLines.length:1)+1};',
    'const rt=at(String(vt2.uri||""),tt2);',
    'if(!rt?.id){Nt("promptbar_missing",`diffId=${String(dt||"")}`,{diffId:String(dt||""),uri:String(vt2.uri||"")});return;}',
    'for(let ut=ht2.length-1;ut>=0;ut--){const ot=ht2[ut];if(ot&&ot.diffId===dt&&String(ot.uri||"")===String(vt2.uri||"")&&ot.currentRangeDecorationId)return}',
    'ht.updateInlineDiffProperty?.(dt,"attachedToPromptBar",!0);',
    'vt.updatePromptBar(rt.id,"diffId",dt);',
    'Nt("promptbar_attached",`diffId=${String(dt||"")}`,{diffId:String(dt||""),promptBarId:String(rt.id||""),uri:String(vt2.uri||"")});',
    'if(!ht?.textModelService?.createModelReference)return;',
    'Promise.resolve(ht.textModelService.createModelReference(vt2.uri,!0)).then(ut=>{',
    'try{',
    'const ot=ut?.object?.textEditorModel;',
    'if(!ot)return;',
    'const lt2=Math.max(1,Number(tt2.startLineNumber)||1);',
    'const mt2=Math.max(lt2,Math.min(ot.getLineCount(),(Number(tt2.endLineNumberExclusive)||lt2+1)-1));',
    'const gt2=ot.deltaDecorations([], [{range:{startLineNumber:lt2,endLineNumber:mt2,startColumn:1,endColumn:ot.getLineMaxColumn(mt2)},options:{description:"promptBar-tracking-range",isWholeLine:!0}}])[0];',
    'gt2&&vt.updatePromptBar(rt.id,"currentRangeDecorationId",gt2);',
    '}finally{ut?.dispose?.()}',
    '}).catch(ut=>{Nt("promptbar_range_error",String(ut?.message||ut||"promptbar_range_failed"),{message:String(ut?.message||ut||"promptbar_range_failed"),diffId:String(dt||"")})});',
    '};',
    'const it=(Ye,Xe,dt)=>{',
    'if(!dt)return;',
    'const ht2=Ze.entries.get(Ye)||{};',
    'ht2.diffId=dt;',
    'ht2.uri=Xe;',
    'Ze.entries.set(Ye,ht2);',
    'ct(ht2);',
    'let vt2=48;',
    'pt(Ye,ht2,dt);',
    'ht2.syncTimer=setInterval(()=>{vt2-=1;pt(Ye,ht2,dt);vt2<=0&&ct(ht2)},250);',
    'ht2.stopTimer=setTimeout(()=>{ct(ht2);const tt2=Ze.entries.get(Ye);tt2&&tt2.diffId===dt&&(tt2.uri=Xe,Ze.entries.set(Ye,tt2))},12e3);',
    '};',
    'const ft=Ye=>{',
    'try{',
    'const Xe=String(Ye?.filePath||Ye?.path||"").trim();',
    'const dt=typeof Ye?.oldText=="string"?Ye.oldText:typeof Ye?.beforeContent=="string"?Ye.beforeContent:"";',
    'const rt=typeof Ye?.newText=="string"?Ye.newText:typeof Ye?.afterContent=="string"?Ye.afterContent:"";',
    'if(!Xe||typeof dt!="string"||typeof rt!="string"||dt===rt)return Promise.resolve(null);',
    'const ut=[Xe,dt,rt].join("\\x1f");',
    'const ot=Ze.entries.get(ut)||{};',
    'const lt2=tt(Xe);',
    'if(!lt2)return Promise.resolve(null);',
    'const mt2=String(lt2);',
    'if(ot.diffId&&lt(ot.diffId)){it(ut,mt2,ot.diffId);return Promise.resolve(ot.diffId)}',
    'if(Ze.pendingKeys?.has(ut))return Promise.resolve(null);',
    'Ze.pendingKeys?.add(ut);',
    'const gt2=String(dt).length?String(dt).split(/\\r?\\n/):[];',
    'const kt2=Et2(Ye);',
    'const st=at(mt2,{startLineNumber:1,endLineNumberExclusive:gt2.length>0?gt2.length+1:1});',
    'const ct2=st?.id;',
    'const yt2=mt(mt2,ot.diffId);',
    'if(yt2?.id&&yt2.id!==ot.diffId){try{ht?.remove?.(yt2.id,{shouldStorePrevState:!1})}catch{}}',
    'Ze.entries.set(ut,{...ot,requestId:String(Ye?.requestId||""),filePath:Xe});',
    'const at2=()=>Promise.resolve(ht?.addDecorationsOnlyDiff?.({',
    'uri:lt2,',
    'generationUUID:`relay:${Date.now().toString(36)}`,' ,
    'currentRange:{startLineNumber:1,endLineNumberExclusive:gt2.length>0?gt2.length+1:1},',
    'originalTextLines:gt2,',
    'prompt:"CursorPool relay edit",',
    'attachedToPromptBar:!0,',
    'hideDeletionViewZones:!1,',
    'showNativeAcceptReject:!0,',
    'composerMetadata:kt2,',
    'createdAt:Date.now()',
    '})).then(Ye=>{',
    'if(!Ye?.id)throw new Error("relay decoration diff was not created");',
    'Nt("diff_created_decorations_only",`diffId=${String(Ye.id||"")}`,{diffId:String(Ye.id||""),uri:mt2});',
    'it(ut,mt2,Ye.id);',
    'return Ye.id;',
    '});',
    'return at2()',
    '}).then(Ye=>{Ze.pendingKeys?.delete(ut);return Ye}).catch(Ye=>{Ze.pendingKeys?.delete(ut);ct(ot);Ze.entries.delete(ut);Nt("attach_review_error",String(Ye?.message||Ye||"attach_review_failed"),{message:String(Ye?.message||Ye||"attach_review_failed"),filePath:Xe});return null})',
    '}catch(Ye){Nt("attach_review_exception",String(Ye?.message||Ye||"attach_review_exception"),{message:String(Ye?.message||Ye||"attach_review_exception")});return Promise.resolve(null)}',
    '};',
    'Ze.attachReview=ft;',
    'Nt("bridge_ready",`mode=${String(y||"")}`,{mode:String(y||""),hasInlineDiffService:Boolean(ht),hasCmdKStateService:Boolean(vt)});',
    'if(!a&&y==="edit"&&e&&typeof t=="string"&&typeof i=="string"&&t!==i){Nt("inline_edit_detected",String(e||""),{filePath:String(e||"")});ft({filePath:e,oldText:t,newText:i})}',
    '},[a,y,e,t,i,C]);',
  ].join('');
}

function buildInlineDiffServiceReviewBridgeBootstrap(uriHelperSymbol = 'Xe') {
  return [
    '((Ye,Xe)=>{',
    'try{',
    `const Ze=globalThis.${REVIEW_BRIDGE_MARKER}||(globalThis.${REVIEW_BRIDGE_MARKER}={entries:new Map(),pendingKeys:new Set(),lastSeq:0,pollTimer:0,pollBusy:!1,pollStarted:!1,debugEnabled:!0});`,
    'const ht=Ye,vt=Ye?.cmdKStateService;',
    `const bt=()=>{const Ye2=[];const Xe2=Number(globalThis.process?.env?.CURSOR_RELAY_PORT)||0;Xe2>0&&Ye2.push(Xe2);Ye2.push(${REVIEW_EVENTS_DEFAULT_PORT});return Array.from(new Set(Ye2.filter(dt=>Number(dt)>0))).map(dt=>\`http://127.0.0.1:\${dt}${REVIEW_EVENTS_PATH}\`)};`,
    `const Et=()=>{const Ye2=[];const Xe2=Number(globalThis.process?.env?.CURSOR_RELAY_PORT)||0;Xe2>0&&Ye2.push(Xe2);Ye2.push(${REVIEW_EVENTS_DEFAULT_PORT});return Array.from(new Set(Ye2.filter(dt=>Number(dt)>0))).map(dt=>\`http://127.0.0.1:\${dt}${REVIEW_BRIDGE_DEBUG_PATH}\`)};`,
    `const It=()=>{const Ye2=[];const Xe2=Number(globalThis.process?.env?.CURSOR_RELAY_PORT)||0;Xe2>0&&Ye2.push(Xe2);Ye2.push(${REVIEW_EVENTS_DEFAULT_PORT});return Array.from(new Set(Ye2.filter(dt=>Number(dt)>0))).map(dt=>\`http://127.0.0.1:\${dt}${REVIEW_ACTIONS_PATH}\`)};`,
    'const Nt=(Ye2,Xe2,dt)=>{',
    'if(Ze.debugEnabled===!1)return Promise.resolve(null);',
    'const ht2={type:String(Ye2||"unknown"),detail:String(Xe2||""),requestId:String(dt?.requestId||dt?.requestID||""),data:dt&&typeof dt=="object"?dt:null};',
    'const vt2=Et();',
    'const tt2=rt=>{if(rt>=vt2.length)return Promise.resolve(null);return Promise.resolve(fetch(vt2[rt],{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(ht2),cache:"no-store"})).catch(()=>tt2(rt+1))};',
    'return Promise.resolve(tt2(0)).catch(()=>null)',
    '};',
    'const At=(Ye2,Xe2)=>{const dt=It(),ht2={action:String(Ye2||""),...(Xe2&&typeof Xe2=="object"?Xe2:{})},vt2=rt=>{if(rt>=dt.length)return Promise.resolve(null);return Promise.resolve(fetch(dt[rt],{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(ht2),cache:"no-store"})).then(ut=>ut?.ok?ut.json():null).catch(()=>vt2(rt+1))};return Promise.resolve(vt2(0)).catch(()=>null)',
    '};',
    'const jt=()=>{try{const Ye2=ht?.workspaceContextService?.getWorkspace?.(),Xe2=Ye2?.folders?.[0]?.uri;if(!Xe2)return "";if(String(Xe2.scheme||"")==="file"){const dt=String(Xe2.fsPath||"").trim();if(dt)return dt;return decodeURIComponent(String(Xe2.path||"").replace(/^\\/([a-zA-Z]:)/,"$1"))}return String(Xe2.fsPath||Xe2.path||"").trim()}catch{return ""}};',
    'const qt=Ye2=>{try{const Xe2=jt(),dt=String(Ye2?.workspaceRoot||"").trim(),ht2=String(Ye2?.filePath||Ye2?.path||"").trim();if(!Xe2)return !dt;const vt2=tt2=>String(tt2||"").replace(/\\\\/g,"/").replace(/^file:\\/\\//i,"").replace(/^\\/([a-zA-Z]:)/,"$1").replace(/\\/+$/,"").toLowerCase(),tt2=vt2(Xe2),rt=vt2(dt),ut=vt2(ht2);const ot=!rt||rt===tt2||rt.endsWith("/"+tt2)||tt2.endsWith("/"+rt),lt=!ut||ut===tt2||ut.startsWith(tt2+"/")||ut.startsWith(rt+"/");if(ot&&lt)return !0;Nt("review_event_workspace_skipped",`eventRoot=${dt||"-"} windowRoot=${Xe2||"-"}`,{requestId:String(Ye2?.requestId||""),workspaceRoot:Xe2,eventWorkspaceRoot:dt,filePath:ht2});return !1}catch{return !0}};',
    'const kt=Ye2=>{',
    'try{',
    'const Xe2=String(Ye2||"").trim();',
    'if(!Xe2)return null;',
    'if(/^file:\\/\\//i.test(Xe2)&&typeof Xe?.parse=="function")return Xe.parse(Xe2);',
    'if(/^[a-zA-Z]:[\\\\/]|^\\//.test(Xe2)&&typeof Xe?.file=="function")return Xe.file(Xe2);',
    'const dt=ht?.workspaceContextService?.getWorkspace?.()?.folders?.[0]?.uri;',
    'if(!dt)return typeof Xe?.parse=="function"?Xe.parse(Xe2):null;',
    'const ht2=Xe2.replace(/\\\\/g,"/").replace(/^\\.\\//,""),vt2=String(dt.path||"").replace(/\\/$/,"");',
    'return typeof dt.with=="function"?dt.with({path:(vt2+"/"+ht2).replace(/\\/+/g,"/")}):null;',
    '}catch{return null}',
    '};',
    'const tt=Ye2=>String(Ye2??"").split(/\\r?\\n/);',
    'const rt=Ye2=>{',
    'const Xe2=String(Ye2?.composerId||Ye2?.cursorConversation?.composerId||"").trim();',
    'if(Xe2)return Xe2;',
    'const dt=ht?.composerDataService?.allComposersData;',
    'const ht2=Array.isArray(dt?.selectedComposerIds)?dt.selectedComposerIds.filter(Boolean):[];',
    'const vt2=Array.isArray(dt?.lastFocusedComposerIds)?dt.lastFocusedComposerIds.filter(Boolean):[];',
    'return String(vt2.find(tt2=>ht2.includes(tt2))||vt2[vt2.length-1]||ht2[ht2.length-1]||"").trim()',
    '};',
    'const nt=Ye2=>{',
    'const Xe2=rt(Ye2);',
    'if(!Xe2)return void 0;',
    'const dt=String(Ye2?.toolCallId||Ye2?.requestId||`relay-${Date.now().toString(36)}`).trim();',
    'return {composerId:Xe2,toolCallId:dt,composerGenerationID:String(Ye2?.requestId||dt)}',
    '};',
    'const ot=Ye2=>{',
    'const Xe2=Array.isArray(Ye2)?Ye2:[];',
    'return {startLineNumber:1,endLineNumberExclusive:Math.max(1,Xe2.length)+1}',
    '};',
    'const st=Ye2=>({selections:Array.isArray(Ye2?.selections)?Ye2.selections:[],selectedDocs:Array.isArray(Ye2?.selectedDocs)?Ye2.selectedDocs:[],selectedCommits:Array.isArray(Ye2?.selectedCommits)?Ye2.selectedCommits:[],selectedLinks:Array.isArray(Ye2?.selectedLinks)?Ye2.selectedLinks:[],externalLinks:Array.isArray(Ye2?.externalLinks)?Ye2.externalLinks:[],images:Array.isArray(Ye2?.images)?Ye2.images:[],selectedImages:Array.isArray(Ye2?.selectedImages)?Ye2.selectedImages:[],fileSelections:Array.isArray(Ye2?.fileSelections)?Ye2.fileSelections:[],folderSelections:Array.isArray(Ye2?.folderSelections)?Ye2.folderSelections:[],terminalSelections:Array.isArray(Ye2?.terminalSelections)?Ye2.terminalSelections:[],terminalFiles:Array.isArray(Ye2?.terminalFiles)?Ye2.terminalFiles:[],selectedPullRequests:Array.isArray(Ye2?.selectedPullRequests)?Ye2.selectedPullRequests:[],composers:Array.isArray(Ye2?.composers)?Ye2.composers:[],cursorRules:Array.isArray(Ye2?.cursorRules)?Ye2.cursorRules:[],cursorCommands:Array.isArray(Ye2?.cursorCommands)?Ye2.cursorCommands:[],gitPRDiffSelections:Array.isArray(Ye2?.gitPRDiffSelections)?Ye2.gitPRDiffSelections:[],subagentSelections:Array.isArray(Ye2?.subagentSelections)?Ye2.subagentSelections:[],browserSelections:Array.isArray(Ye2?.browserSelections)?Ye2.browserSelections:[],extraContext:Array.isArray(Ye2?.extraContext)?Ye2.extraContext:[],initText:String(Ye2?.initText||"")});',
    'const lt=(Ye2,Xe2)=>{',
    'if(!vt||typeof vt.getPromptBars!="function")return "";',
    'try{',
    'const dt=Array.isArray(vt.getPromptBars?.())?vt.getPromptBars():[];',
    'for(let ht2=dt.length-1;ht2>=0;ht2--){const vt2=dt[ht2];if(vt2&&vt2.visible!==!1&&String(vt2.uri||"")===String(Ye2||"")){vt2.data=st(vt2.data);return String(vt2.id||"")}}',
    'for(let ht2=dt.length-1;ht2>=0;ht2--){const vt2=dt[ht2];if(vt2&&vt2.visible!==!1&&!vt2.diffId){vt2.data=st(vt2.data);return String(vt2.id||"")}}',
    'if(typeof vt.addPromptBar!="function")return "";',
    'const ht2=dt.length?dt[dt.length-1]:null,vt2=`relay-promptbar:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,8)}`;',
    'const tt2={...(ht2&&typeof ht2=="object"?ht2:{}),id:vt2,uri:Ye2,diffId:void 0,currentRangeDecorationId:void 0,visible:!0,generating:!1,data:st(ht2?.data),height:Number(ht2?.height)||40,indentColumn:Math.max(1,Number(Xe2?.startLineNumber)||1),forceRerenderInputBox:(Number(ht2?.forceRerenderInputBox)||0)+1,createdAt:Date.now()};',
    'vt.addPromptBar(tt2);',
    'Nt("promptbar_created",`uri=${String(Ye2||"")}`,{uri:String(Ye2||""),promptBarId:vt2});',
    'return vt2;',
    '}catch(dt){Nt("promptbar_create_error",String(dt?.message||dt||"promptbar_failed"),{message:String(dt?.message||dt||"promptbar_failed")});return ""}',
    '};',
    'const mt=(Ye2,Xe2,dt)=>{',
    'try{',
    'dt&&vt?.updatePromptBar?.(dt,"diffId",Xe2);',
    'const ht2=Array.isArray(Ye2?.inlineDiffs?.value)?Ye2.inlineDiffs.value.find(vt2=>vt2&&vt2.id===Xe2):null;',
    'ht2&&Ye2.updateInlineDiffProperty?.(Xe2,"attachedToPromptBar",!0);',
    'Nt("promptbar_attached",`diffId=${String(Xe2||"")}`,{diffId:String(Xe2||""),promptBarId:String(dt||"")});',
    '}catch{}',
    '};',
    'if(!Ze.acceptRejectHooked){Ze.acceptRejectHooked=!0;try{typeof ht.onDidAcceptDiff=="function"&&ht.onDidAcceptDiff(Ye2=>{try{const Xe2=String(Ye2?.diffId||"").trim();if(!Xe2)return;const dt=[...Ze.entries.values()].find(ht2=>String(ht2?.diffId||"").trim()===Xe2);Nt("native_accept",`diffId=${Xe2}`,{diffId:Xe2,requestId:String(dt?.requestId||""),filePath:String(dt?.filePath||dt?.uri||"")});At("accept",{diffId:Xe2,requestId:String(dt?.requestId||""),filePath:String(dt?.filePath||dt?.uri||"")})}catch(dt){Nt("native_accept_error",String(dt?.message||dt||"accept_failed"),{message:String(dt?.message||dt||"accept_failed")})}}),typeof ht.onDidRejectDiff=="function"&&ht.onDidRejectDiff(Ye2=>{try{const Xe2=String(Ye2?.diffId||"").trim();if(!Xe2)return;const dt=[...Ze.entries.values()].find(ht2=>String(ht2?.diffId||"").trim()===Xe2);Nt("native_reject",`diffId=${Xe2}`,{diffId:Xe2,requestId:String(dt?.requestId||""),filePath:String(dt?.filePath||dt?.uri||"")});At("reject",{diffId:Xe2,requestId:String(dt?.requestId||""),filePath:String(dt?.filePath||dt?.uri||"")})}catch(dt){Nt("native_reject_error",String(dt?.message||dt||"reject_failed"),{message:String(dt?.message||dt||"reject_failed")})}})}catch(Ye2){Nt("accept_reject_hook_error",String(Ye2?.message||Ye2||"hook_failed"),{message:String(Ye2?.message||Ye2||"hook_failed")})}}',
    'const gt=Ye2=>{',
    'try{',
    'const Xe2=String(Ye2?.filePath||Ye2?.path||"").trim();',
    'const dt=typeof Ye2?.oldText=="string"?Ye2.oldText:typeof Ye2?.beforeContent=="string"?Ye2.beforeContent:"";',
    'const rt=typeof Ye2?.newText=="string"?Ye2.newText:typeof Ye2?.afterContent=="string"?Ye2.afterContent:"";',
    'if(!Xe2||typeof dt!="string"||typeof rt!="string"||dt===rt)return Promise.resolve(null);',
    'const ut=[Xe2,dt,rt].join("\\x1f");',
    'if(Ze.pendingKeys?.has(ut))return Promise.resolve(null);',
    'const ot2=Ze.entries.get(ut)||{};',
    'if(ot2.diffId)return Promise.resolve(ot2.diffId);',
    'const lt2=kt(Xe2);',
    'if(!lt2)return Promise.resolve(Nt("uri_unresolved",Xe2,{filePath:Xe2}));',
    'Ze.pendingKeys?.add(ut);',
    'const mt2=tt(dt),gt2=tt(rt),st=ot(mt2),$t2=ot(gt2),ct=lt(String(lt2),$t2);',
    'const yt2=nt(Ye2);',
    'Ze.entries.set(ut,{...ot2,requestId:String(Ye2?.requestId||""),filePath:Xe2});',
    'const wt=()=>Promise.resolve(ht?.addDecorationsOnlyDiff?.({uri:lt2,generationUUID:`relay:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,8)}`,currentRange:st,originalTextLines:mt2,prompt:"CursorPool relay edit",attachedToPromptBar:!0,hideDeletionViewZones:!1,showNativeAcceptReject:!0,composerMetadata:yt2,createdAt:Date.now()})).then(yt=>{if(!yt?.id)throw new Error("relay decoration diff was not created");Ze.entries.set(ut,{diffId:yt.id,uri:String(lt2),requestId:String(Ye2?.requestId||""),filePath:Xe2});mt(ht,yt.id,ct);Nt("diff_created_decorations_only",`diffId=${String(yt.id||"")}`,{diffId:String(yt.id||""),uri:String(lt2),oldLines:mt2.length,newLines:gt2.length});return yt.id}).catch(yt=>{Nt("attach_review_error",String(yt?.message||yt||"attach_review_failed"),{message:String(yt?.message||yt||"attach_review_failed"),filePath:Xe2});return null});',
    'return Promise.resolve(wt()).finally(()=>{Ze.pendingKeys?.delete(ut)})',
    '}catch(Xe2){Nt("attach_review_exception",String(Xe2?.message||Xe2||"attach_review_exception"),{message:String(Xe2?.message||Xe2||"attach_review_exception")});return Promise.resolve(null)}',
    '};',
    'const ct=()=>{',
    'if(Ze.pollBusy)return;',
    'Ze.pollBusy=!0;',
    'const Qt=jt();',
    'if(String(Ze.workspaceRoot||"")!==String(Qt||"")){Ze.workspaceRoot=String(Qt||"");Ze.lastSeq=0}',
    'const Ye2=bt();',
    'const Jt=encodeURIComponent(Qt||"");',
    'const Xe2=(dt=>{if(dt>=Ye2.length)return Promise.resolve(null);return Promise.resolve(fetch(`${Ye2[dt]}?after=${Number(Ze.lastSeq)||0}${Jt?`&workspaceRoot=${Jt}`:""}`,{cache:"no-store"})).then(ht2=>ht2?.ok?ht2.json():null).catch(()=>Xe2(dt+1))})(0);',
    'Promise.resolve(Xe2).then(dt=>{',
    'const ht2=Array.isArray(dt?.events)?dt.events:[];',
    'Nt("poll_success",`events=${ht2.length}`,{lastSeq:Number(dt?.lastSeq)||0,count:ht2.length});',
    'const ut=[];',
    'for(const vt2 of ht2){if(!qt(vt2))continue;const tt2=Number(vt2?.seq)||0;Nt("review_event_received",`seq=${tt2} file=${String(vt2?.filePath||vt2?.path||"")}`,{requestId:String(vt2?.requestId||""),seq:tt2,filePath:String(vt2?.filePath||vt2?.path||"")});ut.push(Promise.resolve(gt(vt2)).then(rt=>{if(rt){tt2>Number(Ze.lastSeq||0)&&(Ze.lastSeq=tt2);Nt("review_event_attached",`seq=${tt2} diffId=${String(rt||"")}`,{requestId:String(vt2?.requestId||""),seq:tt2,diffId:String(rt||"")})}else{Nt("review_event_attach_pending",`seq=${tt2}`,{requestId:String(vt2?.requestId||""),seq:tt2})}}).catch(rt=>Nt("review_event_attach_error",String(rt?.message||rt||"attach_failed"),{requestId:String(vt2?.requestId||""),seq:tt2})))}',
    'return Promise.allSettled(ut).then(()=>{if(ut.length===0){const rt=Number(dt?.lastSeq)||0;rt>Number(Ze.lastSeq||0)&&(Ze.lastSeq=rt)}});',
    '}).catch(dt=>Nt("poll_error",String(dt?.message||dt||"poll_failed"),{message:String(dt?.message||dt||"poll_failed")})).finally(()=>{Ze.pollBusy=!1})',
    '};',
    'Ze.attachReview=gt;',
    'if(!Ze.pollStarted){Ze.pollStarted=!0;Nt("poll_boot","inlineDiffService review bridge polling started",{pollIntervalMs:1500,hasInlineDiffService:Boolean(ht),hasCmdKStateService:Boolean(vt)});ct();Ze.pollTimer=setInterval(ct,1500)}',
    'Nt("bridge_ready","inlineDiffService constructor",{hasInlineDiffService:Boolean(ht),hasCmdKStateService:Boolean(vt)});',
    '}catch(Ye2){try{console.warn("CursorPool relay review bridge failed",Ye2)}catch{}}',
    `})(this,${uriHelperSymbol})`,
  ].join('');
}

function patchRelayReviewBridgeInWorkbench(explicitMainJsPath) {
  const workbenchPath = resolveWorkbenchDesktopMainJsPath(explicitMainJsPath);
  if (!workbenchPath) {
    throw new Error('Cursor workbench.desktop.main.js was not found');
  }

  const original = fs.readFileSync(workbenchPath, 'utf8');
  const baseText = hasAnyRelayReviewBridgePatch(original)
    ? restoreRelayReviewBridgePatchedText(original)
    : original;

  let injected = baseText;
  const signatureMatch = findReviewBridgeSignatureVariant(baseText);
  if (signatureMatch) {
    const injectedSignature = applyReviewBridgeSignaturePatch(baseText, signatureMatch.variant);
    if (!injectedSignature.includes(REVIEW_BRIDGE_EFFECT_ANCHOR)) {
      throw new Error('Unable to find edit tool call renderer effect anchor in workbench.desktop.main.js');
    }
    injected = injectedSignature.replace(
      REVIEW_BRIDGE_EFFECT_ANCHOR,
      `},[a,V,t,i]);${buildRelayReviewBridgeEffect()}const Be=di(()=>{`,
    );
  } else if (baseText.includes(INLINE_DIFF_SERVICE_ANCHOR)) {
    injected = baseText.replace(
      INLINE_DIFF_SERVICE_ANCHOR,
      `this._userPlansDir=fV(this.pathService.userHome({preferLocal:!0})),${buildInlineDiffServiceReviewBridgeBootstrap('Xe')},this.experimentService.checkFeatureGate("inline_diffs_v2_adapter")`,
    );
    if (injected.includes(INLINE_DIFF_SERVICE_DELAYED_REGISTRATION)) {
      injected = injected.replace(INLINE_DIFF_SERVICE_DELAYED_REGISTRATION, INLINE_DIFF_SERVICE_EAGER_REGISTRATION);
    }
  } else if (baseText.includes(INLINE_DIFF_SERVICE_ANCHOR_VARIANT)) {
    injected = baseText.replace(
      INLINE_DIFF_SERVICE_ANCHOR_VARIANT,
      `this._userPlansDir=UV(this.pathService.userHome({preferLocal:!0}));${buildInlineDiffServiceReviewBridgeBootstrap('De')}for(const D of edn.registeredActions)D(this.reactiveStorageService);`,
    );
  }

  if (injected === baseText) {
    throw new Error('Unable to find relay review bridge injection point in workbench.desktop.main.js');
  }

  fs.writeFileSync(workbenchPath, injected, 'utf8');
  return {
    ok: true,
    workbenchPath,
    changed: injected !== original,
    alreadyPatched: false,
  };
}

function restoreRelayReviewBridgeInWorkbench(explicitMainJsPath) {
  const workbenchPath = resolveWorkbenchDesktopMainJsPath(explicitMainJsPath);
  if (!workbenchPath) {
    return {
      ok: false,
      exists: false,
      workbenchPath: '',
      changed: false,
      alreadyRestored: true,
    };
  }

  const original = fs.readFileSync(workbenchPath, 'utf8');
  if (!hasAnyRelayReviewBridgePatch(original)) {
    return {
      ok: true,
      exists: true,
      workbenchPath,
      changed: false,
      alreadyRestored: true,
    };
  }

  const restored = restoreRelayReviewBridgePatchedText(original);
  if (restored === original) {
    throw new Error('Relay review bridge restore did not change workbench.desktop.main.js');
  }

  fs.writeFileSync(workbenchPath, restored, 'utf8');
  return {
    ok: true,
    exists: true,
    workbenchPath,
    changed: true,
    alreadyRestored: false,
  };
}

function readRelayReviewBridgePatchStatus(explicitMainJsPath) {
  const workbenchPath = resolveWorkbenchDesktopMainJsPath(explicitMainJsPath);
  if (!workbenchPath) {
    return {
      exists: false,
      workbenchPath: '',
      reviewBridgePatched: false,
    };
  }
  return {
    exists: true,
    workbenchPath,
    reviewBridgePatched: hasRelayReviewBridgePatch(fs.readFileSync(workbenchPath, 'utf8')),
  };
}

module.exports = {
  REVIEW_BRIDGE_MARKER,
  REVIEW_BRIDGE_EFFECT_ANCHOR,
  INLINE_DIFF_SERVICE_ANCHOR,
  INLINE_DIFF_SERVICE_ANCHOR_VARIANT,
  resolveWorkbenchDesktopMainJsPath,
  hasRelayReviewBridgePatch,
  patchRelayReviewBridgeInWorkbench,
  restoreRelayReviewBridgeInWorkbench,
  readRelayReviewBridgePatchStatus,
};
