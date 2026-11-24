import {scheduledDelay} from './pacing.js';
import {edit,docId,transition} from './editor.js';
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(console.error);
let busy=false,epoch=0;
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
chrome.runtime.onInstalled.addListener(()=>notify('Extension reloaded.'));
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m.for==='clipboard')return;
  if(m.takeover){get().then(s=>{if(s?.tab===sender.tab?.id) return notify('Manual input detected.');});return;}
  if(sender.url!==chrome.runtime.getURL('panel.html'))return;
  handle(m).then(result=>reply({result})).catch(e=>reply({error:e.message}));return true;
});
async function model(s,stage){
  const {token,port}=await chrome.storage.local.get(['token','port']);
  if(!token)throw Error('Enter the backend pairing token in settings.');
  const body={collection:s.collection,id:stage==='draft'?s.run:s.reviewId,run:s.run,stage,brief:s.brief,reference:s.reference,count:s.count,preset:s.preset,draft:stage==='review'?s.current:'',runCents:s.runCents,dayCents:s.dayCents};
  const r=await fetch('http://127.0.0.1:'+port+'/plan',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(100000)});
  const data=await r.json();if(!r.ok)throw Error(data.error||'Backend request failed.');
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
  if(busy)throw Error('A request is finishing. Try again in a moment.');
  busy=true;
  const stamp=epoch;
  try{
    if(m.op==='new'){
      const old=await get();if(old?.state==='running')throw Error('Pause the current session first.');
      const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
      if(!docId(tab?.url))throw Error('Open a blank editable Google Doc first.');
      const s={...m.settings,run:crypto.randomUUID(),reviewId:crypto.randomUUID(),tab:tab.id,window:tab.windowId,doc:docId(tab.url),current:'',at:0,actions:[],state:'planning',spent:0,log:[],started:Date.now(),reviewed:false};
      await save(s);
      try {
        const plan=await model(s,'draft');buildActions(s,plan.paragraphs);
        s.mode=plan.mode;s.model=plan.model;s.log.push(plan.mode==='mock'?'Mock plan generated locally':'AI · '+plan.model+' drafted the paragraph plan');s.spent=plan.cost;s.state='ready';await save(s);
      } catch(e){s.state='paused';s.reason=e.message;await save(s);throw e;}
      return;
    }
    let s=await get();if(!s)throw Error('Generate a plan first.');
    if(m.op==='resume'){
      if(!s.actions.length||['done','stopped'].includes(s.state))throw Error('Generate a new plan first.');
      if(s.pending)throw Error('An edit was interrupted. Inspect the document. Use Confirm recovery to continue.');
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
      s.log.push((r.mode==='mock'?'Mock':'AI')+' · full document reviewed, '+r.edits.length+' proposed edits');s.reviewed=true;s.spent+=r.cost;
      if(epoch!==stamp){s.state=(await get()).state;}
      await save(s);return;
    }
    if(s.at===s.actions.length){s.state='done';s.finished=Date.now();await save(s);return;}
    const a=s.actions[s.at];if(!s.activeParagraph||s.lastP!==a.p){s.activeParagraph=Date.now();s.lastP=a.p;}s.pending={after:transition(s.current,a.offset,a.old,a.text)};await save(s);
    s.current=await edit(s,a,()=>epoch!==stamp,async entry=>{s.log.push(entry);});
    delete s.pending;s.at++;s.due=Date.now()+scheduledDelay(s,a);s.log.push((s.mode==='mock'?'Mock':'AI')+' · '+a.label+' · paragraph '+a.p);
    if(epoch!==stamp)s.state=(await get()).state;
    await save(s);
  }catch(e){
    const s=await get();
    if(s?.state==='running'){s.pausedAt=Date.now();s.state='paused';s.reason=e.message;await save(s);}
    throw e;
  }finally{busy=false;}
}
