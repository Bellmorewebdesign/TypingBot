import {etaSeconds,conflicts,resolve,paces,revisions,minimums} from './pacing.js';
import {docId} from './editor.js';
const $=id=>document.getElementById(id),store=chrome.storage.local;
// The backend is on this PC. Nothing to configure: the service only answers this installed extension.
const BACKEND='http://127.0.0.1:4317',RECOVER='cd ~/TypingBot-preview && docker compose up -d';
const ACTIVE=['planning','ready','running','paused'];

/* ---------- inline errors: always beside the control they belong to ---------- */
const FIELD_INPUTS={brief:['brief'],sources:['files','reference'],start:['start'],length:['wantCount','wantWords'],budget:['runCents','dayCents'],run:['toggle']};
function clearErrors(){
  for(const id of Object.keys(FIELD_INPUTS)){const e=$('err-'+id);if(e)e.textContent='';for(const i of FIELD_INPUTS[id])$(i)?.removeAttribute('aria-invalid');}
}
function showError(field,message,focus=true){
  const box=$('err-'+field);box.textContent=message;
  const inputs=FIELD_INPUTS[field].map($);
  if(field!=='start'&&field!=='run')inputs.forEach(i=>i.setAttribute('aria-invalid','true'));
  if(['length','budget'].includes(field))$('more').open=true;
  box.scrollIntoView?.({block:'nearest'});
  if(focus&&inputs[0]&&!inputs[0].disabled)inputs[0].focus({preventScroll:true});
}
class FieldError extends Error{constructor(field,message){super(message);this.field=field;}}
function fieldFor(message){
  if(/PDF|readable text|source|upload|collection/i.test(message))return 'sources';
  return 'start';
}

/* ---------- options ---------- */
function fill(select,map){select.replaceChildren(...Object.entries(map).map(([v,o])=>{const x=document.createElement('option');x.value=v;x.textContent=o.label;return x;}));}
fill($('pace'),paces);fill($('revisions'),revisions);fill($('minimum'),minimums);
const FIELDS=['brief','reference','preset','pace','revisions','minimum','wantCount','wantWords','runCents','dayCents'];
const CHECKS=['finalReview','accelerate'];

const state=await store.get(['prefs','session','collection','fileNames']);
// Upgrade: the old connection settings are no longer used.
await store.remove(['token','port','backend','custom']);
let collection=state.collection||crypto.randomUUID(),fileNames=state.fileNames||[],session=state.session;
await store.set({collection});
const prefs=state.prefs||{preset:['English','Social Studies'].includes(session?.preset)?session.preset:'English'};
for(const k of FIELDS)if(prefs[k]!==undefined)$(k).value=prefs[k];
for(const k of CHECKS)if(prefs[k]!==undefined)$(k).checked=prefs[k];
$('sources').textContent=fileNames.join(' · ');
function savePrefs(){
  const p={};for(const k of FIELDS)p[k]=$(k).value;for(const k of CHECKS)p[k]=$(k).checked;
  store.set({prefs:p});
}
for(const k of [...FIELDS,...CHECKS])$(k).addEventListener('change',savePrefs);
$('brief').addEventListener('input',savePrefs);
$('reference').addEventListener('input',savePrefs);
for(const k of FIELDS)$(k).addEventListener('input',()=>{$(k).removeAttribute('aria-invalid');});

/* ---------- connection: automatic, with one specific recovery step ---------- */
let online=false,rejected=false;
async function ping(){
  try{
    const r=await fetch(BACKEND+'/health',{method:'POST',signal:AbortSignal.timeout(2500),cache:'no-store'});   // POST: Chrome only labels POSTs with this extension's Origin
    rejected=r.status===403;
    if(!r.ok){online=false;}
    else{const d=await r.json();online=!!d.ok;if(d.model)$('mode').textContent=d.model;}
  }catch{online=false;rejected=false;}
  if(rejected)online=false;
  renderConnection();
}
function renderConnection(){
  $('offline').hidden=online;
  if(online)return;
  $('offlineText').textContent=rejected?'TypingBot is running but does not recognise this extension. Reload TypingBot at chrome://extensions, then reopen this panel.':'TypingBot is not running on this PC. Open a terminal and run:';
  $('offlineCmd').textContent=rejected?'':RECOVER;$('copyCmd').hidden=rejected;
  $('mode').textContent='offline';
}
$('copyCmd').onclick=async()=>{try{await navigator.clipboard.writeText(RECOVER);$('copyCmd').textContent='Copied';setTimeout(()=>$('copyCmd').textContent='Copy',1500);}catch{}};
ping();setInterval(ping,3000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)ping();});

/* ---------- worker calls ---------- */
async function call(op,extra={}){
  const r=await chrome.runtime.sendMessage({op,...extra});if(r?.error)throw Error(r.error);return r?.result;
}

/* ---------- sources ---------- */
let uploading=false;
$('files').onchange=async()=>{
  clearErrors();uploading=true;$('clearSources').disabled=true;
  try{
    await ping();if(!online)throw new FieldError('sources','Can not upload while TypingBot is offline. Start it first (see the red box above).');
    for(const f of $('files').files){
      $('sources').textContent='Uploading '+f.name+'…';
      const r=await fetch(BACKEND+'/source?'+new URLSearchParams({id:collection,name:f.name}),{method:'POST',body:f});
      const data=await r.json().catch(()=>({}));if(!r.ok)throw new FieldError('sources',(data.error||'Upload failed')+' ('+f.name+')');
      fileNames.push(data.name);await store.set({collection,fileNames});
    }
  }catch(e){showError('sources',e.message,false);}
  finally{uploading=false;$('clearSources').disabled=false;$('files').value='';$('sources').textContent=fileNames.join(' · ');}
};
$('clearSources').onclick=async()=>{collection=crypto.randomUUID();fileNames=[];await store.set({collection,fileNames});$('sources').textContent='';clearErrors();};

/* ---------- Start ---------- */
let starting=false;
function intField(id,min,max,field,label){
  const raw=$(id).value.trim();if(raw==='')return undefined;       // blank = not specified
  const n=Number(raw);
  if(!Number.isInteger(n)||n<min||n>max)throw new FieldError(field,label+' must be a whole number from '+min+' to '+max+', or left blank.');
  return n;
}
function wantedInputs(){
  const brief=$('brief').value.trim();
  if(!brief)throw new FieldError('brief','Describe what you want written.');
  let wantCount,wantWords,runCents,dayCents;
  try{wantCount=intField('wantCount',1,8,'length','Paragraphs');}catch(e){$('wantCount').setAttribute('aria-invalid','true');throw e;}
  try{wantWords=intField('wantWords',30,400,'length','Words per paragraph');}catch(e){$('wantWords').setAttribute('aria-invalid','true');throw e;}
  try{runCents=intField('runCents',1,10,'budget','The per-session limit')??10;}catch(e){$('runCents').setAttribute('aria-invalid','true');throw e;}
  try{dayCents=intField('dayCents',1,50,'budget','The daily limit')??50;}catch(e){$('dayCents').setAttribute('aria-invalid','true');throw e;}
  return {brief,wantCount,wantWords,runCents,dayCents};
}
async function start(){
  if(starting)return;                       // a double click must never start (or pay for) a second plan
  starting=true;$('start').disabled=true;$('start').textContent='Starting…';clearErrors();$('notes').textContent='';
  try{
    const w=wantedInputs();
    if(uploading)throw new FieldError('sources','Wait for the upload to finish.');
    await ping();
    if(!online)throw new FieldError('start',rejected?'TypingBot does not recognise this extension. Reload it at chrome://extensions.':'TypingBot is not running on this PC. Run this in a terminal: '+RECOVER);
    const settings=resolve({preset:$('preset').value,pace:$('pace').value,revisions:$('revisions').value,minimum:$('minimum').value,finalReview:$('finalReview').checked,accelerate:$('accelerate').checked,runCents:w.runCents,dayCents:w.dayCents,count:w.wantCount,words:w.wantWords});
    const found=conflicts(settings);
    $('notes').replaceChildren(...found.filter(x=>x.level==='warn').map(x=>{const p=document.createElement('p');p.textContent='Note: '+x.message;return p;}));
    const bad=found.find(x=>x.level==='error');if(bad)throw new FieldError('start',bad.message);
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!docId(tab?.url))throw new FieldError('start','Open a Google Doc in this window (the tab must be in front), then click Start.');
    await call('new',{tabId:tab.id,autostart:true,settings:{...settings,brief:w.brief,reference:$('reference').value,preset:$('preset').value,collection,wantCount:w.wantCount,wantWords:w.wantWords,revise:settings.revise}});
  }catch(e){
    const field=e.field||fieldFor(e.message);
    showError(field,e.message);
  }finally{starting=false;$('start').disabled=false;$('start').textContent='Start';}
}
$('setup').onsubmit=e=>{e.preventDefault();start();};

/* ---------- running view ---------- */
$('toggle').onclick=()=>runOp(session?.state==='running'?'pause':'resume');
$('stop').onclick=()=>runOp('stop');
for(const k of ['applied','undone'])$(k).onclick=()=>runOp('recover',{applied:k==='applied'});
async function runOp(op,extra={}){$('err-run').textContent='';try{await call(op,extra);}catch(e){showError('run',e.message,false);}}

function list(id,items){$(id).replaceChildren(...items.map(t=>{const li=document.createElement('li');li.textContent=t;return li;}));}
function duration(n){return n>=3600?(n/3600).toFixed(1)+' h':n>=60?Math.round(n/60)+' min':Math.round(n)+' s';}
let todayUsd=null;
async function usage(){if(!online)return;try{const r=await fetch(BACKEND+'/usage',{method:'POST',cache:'no-store'});if(r.ok)todayUsd=(await r.json()).dayUsd;}catch{}}
setInterval(usage,30000);
function render(){
  const s=session,active=!!s&&ACTIVE.includes(s.state);
  $('setup').hidden=active;$('run').hidden=!active;
  $('last').textContent=!active&&s&&['done','stopped'].includes(s.state)?(s.state==='done'?'Last session finished':'Last session stopped')+(s.reason&&s.state==='stopped'?' · '+s.reason:'')+' · $'+(s.spent||0).toFixed(5)+' app-tracked':'';
  if(!s)return;
  if(s.model)$('mode').textContent=online?s.model:'offline';
  const a=s.actions[s.at],wait=s.state==='running'&&s.due>Date.now();
  const names={'Insert sentence':'Typing','Revise wording':'Revising earlier text','Final review edit':'Applying final review edit'};
  const modelWait=s.state==='planning'||(s.state==='running'&&!a&&s.finalReview&&!s.reviewed);
  $('status').textContent=modelWait?'Waiting for model':s.state==='running'?(wait?'Scheduled pause':a?(names[a.label]||a.label):'Finishing'):s.state==='ready'?'Ready to type':s.state[0].toUpperCase()+s.state.slice(1);
  $('reason').textContent=s.reason||'';
  $('progress').max=Math.max(s.actions.length,1);$('progress').value=s.at;
  $('toggle').textContent=s.state==='running'?'Pause':'Resume';
  $('toggle').disabled=s.state==='planning'||!!s.pending&&s.state!=='paused';
  const t=etaSeconds(s);
  $('metrics').textContent=(s.count?'Paragraph '+(a?.p||s.count)+' of '+s.count+' · ':'')+duration(((s.finished||Date.now())-s.started)/1000)+' elapsed · $'+(s.spent||0).toFixed(5)+' app-tracked'+(todayUsd===null?'':' ($'+todayUsd.toFixed(5)+' today)')+(t===null?(s.state==='paused'?' · ETA unknown while paused':''):' · ETA '+duration(t)+'–'+duration(t*1.25+5));
  $('recovery').hidden=!s.pending||s.state==='running';
  if(s.pending&&s.state!=='running')$('reason').textContent=(s.reason||'')+' Before: '+JSON.stringify(s.current)+' · After: '+JSON.stringify(s.pending.after);
}
function refresh(){
  render();list('log',session?.log||[]);
  list('plan',session?.actions.map((a,i)=>(i===session.at?'Next · ':'')+(a.old?'Replace “'+a.old+'” with ':'Insert ')+a.text)||[]);
}
store.onChanged.addListener(ch=>{if(ch.session){session=ch.session.newValue;refresh();}});
refresh();usage();
let stepping=false;
setInterval(async()=>{render();if(stepping||session?.state!=='running'||session.due>Date.now())return;stepping=true;try{await call('step');}catch(e){showError('run',e.message,false);}finally{stepping=false;}},400);
