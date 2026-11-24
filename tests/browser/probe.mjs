// Manual/CI-optional probe: runs the REAL extension/editor.js against REAL Chromium keyboard + clipboard handling,
// using a stand-in page whose structure mimics Docs' hidden text-input iframe (iframe.docs-texteventtarget-iframe).
// It proves the CDP key/insertText/selection/copy mechanics in a real browser engine. It does NOT prove anything about
// Google Docs itself (canvas rendering, autocorrect, its own key handling): that needs the manual checklist in the README.
import {createRequire} from 'node:module';
import http from 'node:http';
const {chromium}=createRequire(import.meta.url)('playwright');
const page_html=`<!doctype html><title>doc</title><body style="font:16px sans-serif">
<div id="view" style="white-space:pre-wrap;border:1px solid #888;min-height:80px"></div>
<iframe class="docs-texteventtarget-iframe" style="width:400px;height:100px"></iframe>
<script>
const f=document.querySelector('iframe');const d=f.contentDocument;
d.open();d.write('<body contenteditable="true" style="white-space:pre-wrap"></body>');d.close();
d.body.addEventListener('input',()=>{document.getElementById('view').textContent=d.body.innerText.replace(/\\n$/,'')});
f.focus();d.body.focus();
window.docText=()=>d.body.innerText.replace(/\\n$/,'');
</script>`;
const srv=http.createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(page_html);});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+srv.address().port+'/';
const browser=await chromium.launch();
const ctx=await browser.newContext();await ctx.grantPermissions(['clipboard-read','clipboard-write'],{origin:url});
const page=await ctx.newPage();await page.goto(url);
await page.evaluate(()=>{document.querySelector('iframe').focus();document.querySelector('iframe').contentDocument.body.focus();});
const cdp=await ctx.newCDPSession(page);
globalThis.chrome={
  runtime:{getContexts:async()=>[{}],sendMessage:async m=>{
    if(m.write!==undefined)await page.evaluate(t=>navigator.clipboard.writeText(t),m.write);
    return {ok:true,value:await page.evaluate(()=>navigator.clipboard.readText())};}},
  windows:{get:async()=>({focused:true})},
  tabs:{get:async()=>({active:true,url:'https://docs.google.com/document/d/probe/edit',windowId:1})},
  debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async(_,name,params)=>cdp.send(name,params)}
};
const {edit,reconcile,continuation}=await import('../../extension/editor.js');
const S={tab:1,doc:'probe',typos:0,wpm:5000,variation:0,burst:1000};
const results=[];const check=(name,ok,extra='')=>{results.push([ok,name,extra]);console.log((ok?'PASS ':'FAIL ')+name+(extra?'  '+extra:''));};
const doc=()=>page.evaluate(()=>window.docText());
try{
  let cur=await edit({...S,current:''},{offset:0,old:'',text:'The cat sat. The dog ran. The cat slept.'},()=>false);
  check('append text into empty doc and read it back via select-all/copy',cur==='The cat sat. The dog ran. The cat slept.'&&await doc()===cur,JSON.stringify(await doc()));
  cur=await edit({...S,current:cur},{offset:cur.lastIndexOf('The cat'),old:'The cat slept.',text:'The cat woke.'},()=>false);
  check('select and replace the LAST of two repeated phrases; earlier text untouched',await doc()==='The cat sat. The dog ran. The cat woke.',JSON.stringify(await doc()));
  cur=await edit({...S,current:cur},{offset:0,old:'The cat sat.',text:'A cat sat.'},()=>false);
  check('revise an earlier sentence',await doc()==='A cat sat. The dog ran. The cat woke.',JSON.stringify(await doc()));
  let paused=false,n=0;
  await edit({...S,current:cur},{offset:cur.length,old:'',text:' Then it was quiet.'},()=>{if(++n>28)paused=true;return paused;}).catch(()=>{});
  const mid=await doc();
  check('pause interrupts mid-sentence (partial text left, no more keys sent)',mid.startsWith(cur)&&mid.length<cur.length+' Then it was quiet.'.length&&mid!==cur,JSON.stringify(mid));
  const snap=await edit({...S,current:cur},null,()=>false);
  const act={offset:cur.length,old:'',text:' Then it was quiet.'};
  const r=reconcile(cur,cur+act.text,snap,act);
  check('reconcile recognises the partial edit',r.kind==='partial'||r.kind==='after',JSON.stringify(r));
  if(r.kind==='partial'){const done=await edit({...S,current:snap},continuation(act,r),()=>false);
    check('resume completes it exactly once (no duplicate text)',done===cur+act.text&&await doc()===cur+act.text,JSON.stringify(await doc()));}
  await page.evaluate(()=>{const b=document.querySelector('iframe').contentDocument.body;b.textContent+=' (typed by someone else)';b.dispatchEvent(new Event('input'));});
  let refused=false;try{await edit({...S,current:cur+act.text},{offset:(cur+act.text).length,old:'',text:' More.'},()=>false);}catch(e){refused=/differs/.test(e.message);}
  check('outside edit is detected and nothing is typed over it',refused);
}catch(e){check('probe crashed',false,e.message);}
await browser.close();srv.close();
process.exit(results.every(r=>r[0])?0:1);
