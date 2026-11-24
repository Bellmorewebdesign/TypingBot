import {defaults,etaSeconds,conflicts} from './pacing.js';
const $=id=>document.getElementById(id),store=chrome.storage.local;
const fields={
  wpm:['Average typing speed (WPM)',8,300],minWpm:['Minimum typing speed (WPM)',4,300],maxWpm:['Maximum typing speed (WPM)',8,400],variation:['Variation between keystrokes (%)',0,90],
  burst:['Words per typing burst',1,30],punctPause:['Pause after punctuation (seconds)',0,10],sentencePause:['Sentence pause (seconds)',0,240],
  breakChance:['Short break chance per sentence (%)',0,100],breakSeconds:['Short break length (seconds)',0,1800],longChance:['Long break chance per sentence (%)',0,100],longSeconds:['Long break length (seconds)',0,3600],
  typos:['Typos per 100 letters',0,15],typoDelay:['Typo correction delay (ms)',0,3000],
  reviewRate:['Wording revision chance (%)',0,100],revisit:['Sentences back to revisit (max)',0,10],minMinutes:['Minimum minutes per paragraph',0,180]
};
for(const [key,[name,min,max]] of Object.entries(fields)){
  const l=document.createElement('label');l.textContent=name;
  const input=document.createElement('input');Object.assign(input,{id:key,type:'number',min,max,required:true});l.append(input);$('knobs').append(l);
}
const settings=()=>Object.fromEntries([...Object.keys(fields),'count','words','runCents','dayCents'].map(k=>[k,Number($(k).value)]));
function loadPreset(values){for(const [k,v] of Object.entries(values||{})){if($(k))$(k).value=v;}}
const state=await store.get(['token','port','backend','custom','session','collection','fileNames']);
let collection=state.collection||crypto.randomUUID(),fileNames=state.fileNames||[],session=state.session;
await store.set({collection});
$('sources').textContent=fileNames.join(' · ');$('token').value=state.token||'';$('backend').value=state.backend||'http://127.0.0.1:'+(state.port||4317);
$('connection').open=!state.token;
if(session){
  $('preset').value=session.preset;loadPreset(session);
  for(const k of ['revise','finalReview'])$(k).checked=session[k];
}else loadPreset(defaults.English);
$('preset').onchange=async()=>loadPreset(defaults[$('preset').value]||(await store.get('custom')).custom||defaults.English);
$('savePreset').onclick=async()=>{await store.set({custom:settings()});$('preset').value='Custom';message('Custom preset saved.');};
$('fast').onclick=()=>{loadPreset({minMinutes:0,sentencePause:0,breakChance:0,longChance:0,punctPause:0,wpm:180,minWpm:100,maxWpm:300,typoDelay:100});message('Test timing selected.');};
function message(m){$('msg').textContent=m;}
function showIssues(items){$('issues').replaceChildren(...items.map(i=>{const p=document.createElement('p');p.textContent=(i.level==='error'?'Conflict: ':'Note: ')+i.message;return p;}));}
async function call(op,extra={}){
  const r=await chrome.runtime.sendMessage({op,...extra});if(r?.error)throw Error(r.error);return r?.result;
}
async function guarded(fn){try{await fn();}catch(e){message(e.message);}}
async function connect(){
  const token=$('token').value.trim();let url;
  try{url=new URL($('backend').value.trim());}catch{throw Error('Enter a valid backend URL.');}
  if(!['http:','https:'].includes(url.protocol)||token.length<20)throw Error('Enter a valid backend URL and pairing token.');
  const origin=url.origin,local=['127.0.0.1','localhost'].includes(url.hostname);
  // Non-local backends need a one-time browser permission for that origin (granted by clicking Allow).
  if(!local&&!(await chrome.permissions.contains({origins:[origin+'/*']}))&&!(await chrome.permissions.request({origins:[origin+'/*']})))throw Error('Permission to reach '+origin+' was not granted.');
  const r=await fetch(origin+'/health',{headers:{Authorization:'Bearer '+token}});
  if(!r.ok)throw Error('Connection failed. Check the pairing token.');
  const data=await r.json();await store.set({backend:origin,token});$('mode').textContent=data.model||data.mode;return {url:origin,token};
}
$('connect').onclick=()=>guarded(async()=>{await connect();message('Connected.');});
let uploading=false;
$('files').onchange=()=>guarded(async()=>{
  uploading=true;$('clearSources').disabled=true;
  try{
    const {url,token}=await connect();
    for(const f of $('files').files){
      message('Uploading '+f.name);
      const r=await fetch(url+'/source?'+new URLSearchParams({id:collection,name:f.name}),{method:'POST',headers:{Authorization:'Bearer '+token},body:f});
      const data=await r.json();if(!r.ok)throw Error(data.error);
      fileNames.push(data.name);await store.set({collection,fileNames});$('sources').textContent=fileNames.join(' · ');
    }
    message('Sources ready.');
  }finally{uploading=false;$('clearSources').disabled=false;$('files').value='';}
});
$('clearSources').onclick=async()=>{collection=crypto.randomUUID();fileNames=[];await store.set({collection,fileNames});$('sources').textContent='';message('New source collection selected.');};
$('form').onsubmit=e=>{e.preventDefault();guarded(async()=>{
  if(uploading)throw Error('Wait for the upload to finish.');
  const found=conflicts(settings());showIssues(found);
  if(found.some(x=>x.level==='error'))throw Error('Fix the settings conflict before starting.');
  await connect();message('Generating plan…');
  await call('new',{settings:{...settings(),brief:$('brief').value,reference:$('reference').value,preset:$('preset').value,revise:$('revise').checked,finalReview:$('finalReview').checked,collection}});
  message('Plan ready. Click inside a blank Google Doc, then Run.');
});};
for(const op of ['resume','pause','stop'])$(op).onclick=()=>guarded(async()=>{await call(op);message('');});
for(const k of ['applied','undone'])$(k).onclick=()=>guarded(async()=>{await call('recover',{applied:k==='applied'});message('Recovery recorded.');});
function list(id,items){$(id).replaceChildren(...items.map(t=>{const li=document.createElement('li');li.textContent=t;return li;}));}
function duration(n){return n>=3600?(n/3600).toFixed(1)+' h':n>=60?Math.round(n/60)+' min':Math.round(n)+' s';}
function render(){
  const s=session;
  $('resume').disabled=!s||!!s.pending||!s.actions.length||['running','done','stopped'].includes(s.state);
  $('pause').disabled=s?.state!=='running';$('stop').disabled=!s||['done','stopped','planning'].includes(s.state);
  if(!s)return;
  $('mode').textContent=s.model||(s.mode||'');const a=s.actions[s.at];
  const wait=s.state==='running'&&s.due>Date.now();
  const names={'Insert sentence':'Typing','Revise wording':'Revising earlier text','Final review edit':'Applying final review edit'};
  const modelWait=s.state==='planning'||(s.state==='running'&&!a&&s.finalReview&&!s.reviewed);
  $('status').textContent=modelWait?'Waiting for model':s.state==='running'?(wait?'Scheduled pause':a?(names[a.label]||a.label):'Finishing'):s.state[0].toUpperCase()+s.state.slice(1);
  $('reason').textContent=s.reason||'';$('progress').max=Math.max(s.actions.length,1);$('progress').value=s.at;
  const t=etaSeconds(s);
  $('metrics').textContent='Paragraph '+(a?.p||s.count)+' of '+s.count+' · '+duration(((s.finished||Date.now())-s.started)/1000)+' elapsed · $'+s.spent.toFixed(5)+' app-tracked'+(todayUsd===null?'':' ($'+todayUsd.toFixed(5)+' today)')+(t===null?(s.state==='paused'?' · ETA unknown while paused':''):' · ETA '+duration(t)+'–'+duration(t*1.25+5));
  $('recovery').hidden=!s.pending||s.state==='running';
  if(s.pending&&s.state!=='running')$('reason').textContent=(s.reason||'')+' Before: '+JSON.stringify(s.current)+' · After: '+JSON.stringify(s.pending.after);
}
function refresh(){
  render();list('log',session?.log||[]);
  list('plan',session?.actions.map((a,i)=>(i===session.at?'Next · ':'')+(a.old?'Replace “'+a.old+'” with ':'Insert ')+a.text)||[]);
}
store.onChanged.addListener(ch=>{if(ch.session){session=ch.session.newValue;refresh();}});
refresh();
let todayUsd=null;
async function usage(){try{const {backend,token}=await store.get(['backend','token']);if(!backend||!token)return;const r=await fetch(backend+'/usage',{headers:{Authorization:'Bearer '+token}});if(r.ok)todayUsd=(await r.json()).dayUsd;}catch{}}
usage();setInterval(usage,30000);
let stepping=false;
setInterval(async()=>{render();if(stepping||session?.state!=='running'||session.due>Date.now())return;stepping=true;try{await call('step');}catch(e){message(e.message);}finally{stepping=false;}},400);
