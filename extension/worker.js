import {scheduledDelay} from './pacing.js';
import {edit,docId,transition,reconcile,continuation} from './editor.js';
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(console.error);
let busy=false,epoch=0,starting=null;
const get=async()=> (await chrome.storage.local.get('session')).session;
const save=s=>chrome.storage.local.set({session:s});
const notify=async message=>{
  epoch++;
  const s=await get();
  if(s?.state==='running'){s.pausedAt=Date.now();s.state='paused';s.reason=message;await save(s);}
};
chrome.tabs.onActivated.addListener(async({tabId,windowId})=>{const s=await get();if(s?.window===windowId&&s.tab!==tabId)await notify('Linked tab lost focus.');});
chrome.tabs.onUpdated.addListener(async(id,info)=>{if(info.status==='loading'&&(await get())?.tab===id)await notify('Document reloaded.');});
chrome.runtime.onStartup.addListener(()=>notify('Browser restarted.'));
chrome.runtime.onInstalled.addListener(()=>{chrome.storage.local.remove(['token','port','backend']);return notify('Extension reloaded.');});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m.for==='clipboard')return;
  if(m.takeover){get().then(s=>{if(s?.tab===sender.tab?.id) return notify('Manual input detected.');});return;}
  if(sender.url!==chrome.runtime.getURL('panel.html'))return;
  handle(m).then(result=>reply({result})).catch(e=>reply({error:e.message}));return true;
});
// The backend is this PC only. The service accepts requests only from this installed extension (checked by the browser-set
// Origin header), so there is nothing to configure or copy.
const BACKEND='http://127.0.0.1:4317';
export const OFFLINE='TypingBot is not running on this PC. In a terminal run: cd ~/TypingBot-preview && docker compose up -d';
async function model(s,stage){
  // Length is optional: only what the user typed is sent. The model chooses otherwise.
  const body={id:stage==='draft'?s.run:s.reviewId,run:s.run,stage,collection:s.collection,brief:s.brief,reference:s.reference,preset:s.preset,draft:stage==='review'?s.current:'',runCents:s.runCents,dayCents:s.dayCents};
  if(stage==='draft'){if(s.wantCount)body.count=s.wantCount;if(s.wantWords)body.words=s.wantWords;}
  let r;
  try{r=await fetch(BACKEND+'/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(100000)});}
  catch(e){throw Error(e.name==='TimeoutError'?'The model took too long to answer. Nothing was typed; click Start to try again.':OFFLINE);}
  const data=await r.json().catch(()=>({}));
  if(r.status===403)throw Error('TypingBot is running but does not recognise this extension. Reload TypingBot at chrome://extensions.');
  if(!r.ok)throw Error(data.error||'Backend request failed.');
  return data;
}
function buildActions(s,paragraphs){
  let doc='';
  const add=(offset,old,text,label,p)=>{s.actions.push({offset,old,text,label,p});doc=transition(doc,offset,old,text);};
  for(const [i,p] of paragraphs.entries()){
    const start=doc.length+(i?1:0);
    const sentences=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(p.draft)];
    for(const [j,v] of sentences.entries())add(doc.length,'',(i&&j===0?'\n':'')+v.segment,'Insert sentence',i+1);
    if(p.old&&s.revise&&Math.random()*100<s.reviewRate){
      // Return to the earlier sentence after one or more subsequent sentences.
      const offset=start+p.draft.indexOf(p.old),base=s.actions.length-sentences.length;
      let first=base, written=i?start-1:start;
      while(first<s.actions.length && written<offset+p.old.length){written+=s.actions[first].text.length;first++;}
      const pos=Math.min(s.actions.length,first+Math.floor(Math.random()*(s.revisit+1)));
      const later=s.actions.splice(pos);
      s.actions.push({offset,old:p.old,text:p.text,label:'Revise wording',p:i+1});
      for(const a of later)s.actions.push({...a,offset:a.offset+p.text.length-p.old.length});
      doc=transition(doc,offset,p.old,p.text);
    }
  }
}
async function handle(m){
  if(m.op==='pause'||m.op==='stop'){
    await notify(m.op==='pause'?'Paused by you.':'Stopped.');
    if(m.op==='stop'){const s=await get();if(s){s.state='stopped';s.finished=Date.now();await save(s);}}
    return;
  }
  // A second Start while the first is still planning joins it: it must never trigger a second paid model request.
  if(m.op==='new'){if(starting)return starting;starting=run(m).finally(()=>{starting=null;});return starting;}
  return run(m);
}
async function run(m){
  if(busy)throw Error('A request is finishing. Try again in a moment.');
  busy=true;
  const stamp=epoch;
  try{
    if(m.op==='new'){
      const old=await get();if(['running','planning'].includes(old?.state))throw Error('A session is already in progress. Stop it first.');
      const tab=m.tabId?await chrome.tabs.get(m.tabId).catch(()=>null):null;
      if(!docId(tab?.url))throw Error('Open a Google Doc in this window, then click Start.');
      const s={...m.settings,run:crypto.randomUUID(),reviewId:crypto.randomUUID(),tab:tab.id,window:tab.windowId,doc:docId(tab.url),current:'',at:0,actions:[],state:'planning',spent:0,log:[],started:Date.now(),reviewed:false};
      await save(s);
      try {
        const plan=await model(s,'draft');buildActions(s,plan.paragraphs);
        s.count=plan.paragraphs.length; // the model may have chosen it
        s.mode=plan.mode;s.model=plan.model;s.log.push(plan.mode==='mock'?'Model (mock, no API spend) · paragraph plan generated locally':'Model · '+plan.model+' decided the paragraph text and proposed revisions');
        if(plan.note)s.log.push('Model note · '+plan.note);
        s.spent=plan.cost;s.state=m.autostart?'running':'ready';s.reason='';await save(s);
      } catch(e){s.state='stopped';s.reason=e.message;s.finished=Date.now();await save(s);throw e;}
      return;
    }
    let s=await get();if(!s)throw Error('Generate a plan first.');
    if(m.op==='resume'){
      if(!s.actions.length||['done','stopped'].includes(s.state))throw Error('Generate a new plan first.');
      if(s.pending){
        // Never replay blindly: read the document and compare with the states before/after the interrupted edit.
        const snap=(await edit(s,null,()=>false))??'',act=s.actions[s.at],r=reconcile(s.current,s.pending.after,snap,act);
        if(r.kind==='unknown')throw Error('The document matches neither the text before nor after the interrupted edit. Restore one of them, then use Matches before / Matches after.');
        if(r.kind==='after'){s.current=s.pending.after;s.at++;s.log.push('Reconciled · the interrupted edit had completed and was not repeated');}
        else if(r.kind==='partial'){s.current=snap;s.actions[s.at]=continuation(act,r);s.log.push('Reconciled · continuing a partly typed edit');}
        else s.log.push('Reconciled · the interrupted edit had not started; document unchanged');
        delete s.pending;
      }
      if(s.pausedAt){const d=Date.now()-s.pausedAt;if(s.activeParagraph)s.activeParagraph+=d;if(s.due)s.due+=d;}delete s.pausedAt;s.state='running';s.reason='';await save(s);return;
    }
    if(m.op==='recover'){
      if(!s.pending||s.state==='running')throw Error('No interrupted edit.');
      // Explicit choice is checked against the full document on the next write.
      if(m.applied){s.current=s.pending.after;s.log.push(s.actions[s.at].label+' (manually confirmed)');s.at++;}
      delete s.pending;s.state='paused';s.reason='Recovery recorded.';await save(s);return;
    }
    if(m.op!=='step'||s.state!=='running')return;
    if(s.pending){await notify('Unconfirmed edit. Inspect before resuming.');return;}
    if(s.due>Date.now())return;
    if(s.at===s.actions.length && !s.reviewed && s.finalReview){
      const r=await model(s,'review');
      let text=s.current;
      for(const e of r.edits){if(text.split(e.old).length!==2)continue;const offset=text.indexOf(e.old);s.actions.push({...e,offset,label:'Final review edit',p:s.count});text=transition(text,offset,e.old,e.text);}
      s.log.push('Model'+(r.mode==='mock'?' (mock)':'')+' · full document reviewed, '+r.edits.length+' proposed edit(s)');s.reviewed=true;s.spent+=r.cost;
      if(epoch!==stamp){s.state=(await get()).state;}
      await save(s);return;
    }
    if(s.at===s.actions.length){s.state='done';s.finished=Date.now();await save(s);return;}
    const a=s.actions[s.at];if(!s.activeParagraph||s.lastP!==a.p){s.activeParagraph=Date.now();s.lastP=a.p;}s.pending={after:transition(s.current,a.offset,a.old,a.text)};await save(s);
    s.current=await edit(s,a,()=>epoch!==stamp,async entry=>{s.log.push(entry);});
    delete s.pending;s.at++;s.due=Date.now()+scheduledDelay(s,a);s.log.push('Playback · '+a.label+' · paragraph '+a.p);
    if(epoch!==stamp)s.state=(await get()).state;
    await save(s);
  }catch(e){
    const s=await get();
    if(s?.state==='running'){s.pausedAt=Date.now();s.state='paused';s.reason=e.message;await save(s);}
    throw e;
  }finally{busy=false;}
}
