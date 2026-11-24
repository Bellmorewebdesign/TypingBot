// End-to-end tests of the PACKAGED extension in real Chromium, driving the real panel and Start button against the real
// backend in mock mode (no API spend). The Google Doc is a stand-in page served at a docs.google.com URL whose hidden
// input iframe mimics Docs' structure, so the extension's own guards, debugger, clipboard and takeover code all run.
// Nothing here proves behaviour inside a real signed-in Google Doc: see docs/DOCS-INTEGRATION.md.
import test, {before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ledger,app,EXTENSION_ID} from '../../server/main.ts';
const {chromium}=createRequire(import.meta.url)('playwright');

const DOC_URL='https://docs.google.com/document/d/TESTDOC/edit';
const DOC_HTML=`<!doctype html><title>Untitled document</title><body style="font:16px sans-serif">
<div id="view" style="white-space:pre-wrap;border:1px solid #888;min-height:80px"></div>
<iframe class="docs-texteventtarget-iframe" style="width:400px;height:100px"></iframe>
<script>
const f=document.querySelector('iframe'),d=f.contentDocument;
d.open();d.write('<body contenteditable="true" style="white-space:pre-wrap"></body>');d.close();
d.body.addEventListener('input',()=>{document.getElementById('view').textContent=d.body.innerText.replace(/\\n$/,'')});
f.focus();d.body.focus();
window.docText=()=>d.body.innerText.replace(/\\n$/,'');
</script>`;

const EXT=resolve('extension');                // resolve before changing directory
const dataDir=mkdtempSync(join(tmpdir(),'tb-data-'));
process.chdir(dataDir);                        // server keeps sources under ./data
const dbPath=join(dataDir,'ledger.sqlite');
let db,server,ctx,sw,docPage,panel,t0=0;

const startServer=async()=>{db=ledger(dbPath);server=app(db,{});await new Promise((r,j)=>{server.once('error',j);server.listen(4317,'127.0.0.1',r);});};
const stopServer=async()=>{await new Promise(r=>server.close(r));server.closeAllConnections?.();db.close();};
const paidRequests=()=>{const d=ledger(dbPath);try{return d.prepare('SELECT COUNT(*) n FROM calls').get().n;}finally{d.close();}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=20000,what='condition')=>{const t=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-t>ms)throw Error('Timed out waiting for '+what);await sleep(150);}};
const docText=()=>docPage.evaluate(()=>window.docText());
const session=()=>sw.evaluate(async()=>(await chrome.storage.local.get('session')).session);
// A session started by THIS test (never a stale one a previous test's worker finished writing late).
const planned=async()=>{const x=await session();return x&&x.count&&x.started>=t0?x:null;};
const settle=async()=>{
  if(panel&&!panel.isClosed())await panel.evaluate(()=>chrome.runtime.sendMessage({op:'stop'})).catch(()=>{});
  await until(async()=>{const s=await session();return !s||!['running','planning'].includes(s.state);},15000,'session to stop').catch(()=>{});
  await sleep(1500);                                    // let any in-flight worker step finish writing before storage is cleared
};
const planFetches=()=>sw.evaluate(()=>self.__log.filter(x=>x.u.endsWith('/plan')).map(x=>JSON.parse(x.body)));

// Open the panel in its own window so the Google Doc tab stays the active tab of ITS window, as with the real side panel.
async function openPanel({docIsActiveTab=true}={}){
  t0=Date.now();
  if(panel)await panel.close().catch(()=>{});
  const id=EXTENSION_ID,before=ctx.pages().length;
  const cdp=await ctx.newCDPSession(docPage);
  await cdp.send('Target.createTarget',{url:'chrome-extension://'+id+'/panel.html',newWindow:true});
  panel=await until(()=>ctx.pages().find(p=>p.url().startsWith('chrome-extension://')&&p.url().endsWith('panel.html')),10000,'panel window');
  await panel.waitForSelector('#start');
  // The real side panel lives in the Docs window, so "the active tab" is the document. A standalone window cannot say that,
  // so the test answers the panel's one tabs.query call with the Docs tab. Everything else is untouched.
  const tab=await sw.evaluate(async()=>{const [t]=await chrome.tabs.query({url:'https://docs.google.com/*'});return {id:t.id,url:t.url};});
  await panel.evaluate(({tab,docIsActiveTab})=>{const q=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async i=>i?.active&&i?.currentWindow?(docIsActiveTab?[tab]:[{id:-1,url:'https://example.com/'}]):q(i);},{tab,docIsActiveTab});
  void before;
  await docPage.bringToFront();
}
const text=sel=>panel.locator(sel).innerText();
const eventually=async(sel,re,ms=8000)=>{let v='';await until(async()=>{v=await panel.locator(sel).textContent();return re.test(v);},ms,sel+' to match '+re).catch(e=>{throw Error(e.message+' (got '+JSON.stringify(v)+')');});return v;};

before(async()=>{
  await startServer();
  const ext=EXT;
  ctx=await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(),'tb-prof-')),{headless:false,args:['--headless=new','--no-sandbox','--disable-extensions-except='+ext,'--load-extension='+ext]});
  await ctx.route('https://docs.google.com/**',r=>r.fulfill({contentType:'text/html',body:DOC_HTML}));
  docPage=await ctx.newPage();await docPage.goto(DOC_URL);
  sw=await until(()=>ctx.serviceWorkers().find(w=>w.url().endsWith('/worker.js')),20000,'service worker');
});
after(async()=>{await ctx?.close();await stopServer().catch(()=>{});});

beforeEach(async()=>{
  await settle();
  if(!server.listening)await startServer();
  await sw.evaluate(async()=>{
    await chrome.storage.local.clear();
    if(!self.__log){self.__log=[];const f=self.fetch.bind(self);self.fetch=async(u,o)=>{self.__log.push({u:String(u),body:o?.body});return f(u,o);};}
    self.__log.length=0;
  });
  const d=ledger(dbPath);d.exec('DELETE FROM calls');d.close();
  await docPage.goto(DOC_URL);
});

test('the extension ID is the pinned one, so the backend can recognise it',async()=>{
  assert.equal(new URL(sw.url()).host,EXTENSION_ID);
});

test('fresh install: no connection setup anywhere; connects by itself; Start is the only action',async()=>{
  await openPanel();
  for(const gone of ['#token','#backend','#port','#connect','#count','#knobs'])assert.equal(await panel.locator(gone).count(),0,gone+' should not exist');
  assert.equal(await panel.locator('button:has-text("Save and test")').count(),0);
  await until(async()=>(await text('#mode')).includes('local mock'),8000,'automatic connection');
  assert.equal(await panel.locator('#offline').isHidden(),true);
  assert.equal(await panel.locator('#start').innerText(),'Start');
  // length is blank by default under More options
  assert.equal(await panel.inputValue('#wantWords'),'');assert.equal(await panel.inputValue('#wantCount'),'');
  // the browser really sends the extension Origin the backend relies on
  assert.equal(paidRequests(),0);
});

test('a click on Start never does nothing: each problem is explained beside its control, and costs nothing',async()=>{
  await openPanel();
  await panel.click('#start');
  await eventually('#err-brief',/Describe what you want/);
  assert.equal(await panel.locator('#brief').getAttribute('aria-invalid'),'true');
  await panel.fill('#brief','About rivers.');
  await panel.click('#more summary');
  await panel.fill('#wantWords','5');await panel.click('#start');
  await eventually('#err-length',/Words per paragraph must be a whole number from 30 to 400/);
  assert.equal(await panel.locator('#more').evaluate(e=>e.open),true);                 // the hidden section is opened
  await panel.fill('#wantWords','');await panel.fill('#runCents','99');await panel.click('#start');
  await eventually('#err-budget',/per-session limit/);
  await sw.evaluate(()=>chrome.storage.local.clear());                              // forget the invalid value saved above
  await openPanel({docIsActiveTab:false});await panel.fill('#brief','About rivers.');await panel.click('#start');
  await eventually('#err-start',/Open a Google Doc in this window/);
  assert.equal(paidRequests(),0);
});

test('brief with a word count: the instruction is used and no default length is invented',async()=>{
  await openPanel();
  await panel.fill('#brief','Write about rivers, about 300 words across three paragraphs.');
  await panel.click('#more summary');await panel.check('#accelerate');
  await panel.click('#start');
  await until(async()=>(await session())?.state==='running','',0).catch(()=>{});
  const s=await until(async()=>{const x=await session();return x&&x.count&&x.started>=t0?x:null;},15000,'plan');
  assert.equal(s.count,3);                                   // taken from the brief, not from a form default
  assert.equal(s.wantWords,undefined);assert.equal(s.wantCount,undefined);
  const [body]=await planFetches();
  assert.equal('words' in body,false);assert.equal('count' in body,false);
  assert.match(body.brief,/about 300 words across three paragraphs/);
  assert.equal(paidRequests(),1);
  await panel.click('#stop');
});

test('brief without a length: nothing about length is sent and Claude (mock) chooses',async()=>{
  await openPanel();
  await panel.fill('#brief','A short note about rivers.');
  await panel.click('#more summary');await panel.check('#accelerate');
  await panel.click('#start');
  const s=await until(async()=>{const x=await session();return x&&x.count&&x.started>=t0?x:null;},15000,'plan');
  const [body]=await planFetches();
  assert.equal('words' in body,false);assert.equal('count' in body,false);
  assert.equal(s.count,2);
  await panel.click('#stop');
});

test('a length override under More options is sent only when filled in',async()=>{
  await openPanel();
  await panel.fill('#brief','A note about rivers.');
  await panel.click('#more summary');await panel.check('#accelerate');
  await panel.fill('#wantCount','4');await panel.fill('#wantWords','60');
  await panel.click('#start');
  const s=await until(async()=>{const x=await session();return x&&x.count&&x.started>=t0?x:null;},15000,'plan');
  const [body]=await planFetches();
  assert.equal(body.count,4);assert.equal(body.words,60);assert.equal(s.count,4);
  await panel.click('#stop');
});

test('double-clicking Start pays for exactly one plan',async()=>{
  await openPanel();
  await panel.fill('#brief','A note about rivers.');
  await panel.click('#more summary');await panel.check('#accelerate');
  await panel.dblclick('#start');
  await until(async()=>{const x=await session();return x&&x.count&&x.started>=t0;},15000,'plan');
  await sleep(1500);
  assert.equal(paidRequests(),1);
  assert.equal((await planFetches()).length,1);
  await panel.click('#stop');
});

test('two Start messages racing in the worker (two panels) still pay once',async()=>{
  await openPanel();
  const tab=await sw.evaluate(async()=>{const [t]=await chrome.tabs.query({url:'https://docs.google.com/*'});return t.id;});
  const msg={op:'new',tabId:tab,autostart:true,settings:{brief:'Rivers',reference:'',preset:'English',collection:crypto.randomUUID(),runCents:10,dayCents:50,wpm:180,minWpm:100,maxWpm:300,variation:0,typos:0,burst:100,sentencePause:0,breakChance:0,breakSeconds:0,revisit:0,minMinutes:0,reviewRate:0,finalReview:false,revise:false}};
  const results=await Promise.all([panel.evaluate(m=>chrome.runtime.sendMessage(m),msg),panel.evaluate(m=>chrome.runtime.sendMessage(m),msg)]);
  assert.ok(results.every(r=>!r?.error),JSON.stringify(results));
  await sleep(1000);
  assert.equal(paidRequests(),1);
  await panel.click('#stop');
});

test('backend restart: the panel notices, explains one recovery step, and reconnects without a reload',async()=>{
  await openPanel();
  await until(async()=>(await text('#mode')).includes('local mock'),8000,'connection');
  await stopServer();
  await until(async()=>await panel.locator('#offline').isVisible(),10000,'offline banner');
  await eventually('#offlineCmd',/docker compose up -d/);
  await eventually('#offlineText',/not running on this PC/);
  await panel.fill('#brief','A note about rivers.');
  await panel.click('#start');
  await eventually('#err-start',/docker compose up -d/);   // explained beside Start, not silent
  await startServer();
  await until(async()=>await panel.locator('#offline').isHidden(),10000,'reconnect');
  await panel.click('#more summary');await panel.check('#accelerate');
  await panel.click('#start');
  await until(async()=>{const x=await session();return x&&x.count&&x.started>=t0;},15000,'plan after restart');
  assert.equal(paidRequests(),1);
  await panel.click('#stop');
});

test('upgrade: old token/port/backend settings are dropped, the old session and preset survive, Start works',async()=>{
  await sw.evaluate(async()=>chrome.storage.local.set({
    token:'t'.repeat(40),port:4317,backend:'http://127.0.0.1:4317',custom:{wpm:99},collection:'11111111-1111-4111-8111-111111111111',fileNames:['Notes.txt'],
    session:{state:'stopped',finished:Date.now(),started:Date.now()-5000,preset:'Social Studies',count:1,words:120,spent:0.001,at:1,actions:[{offset:0,old:'',text:'Old.',label:'Insert sentence',p:1}],log:['Playback · Insert sentence · paragraph 1'],current:'Old.'},
  }));
  await openPanel();
  await until(async()=>(await text('#mode')).includes('local mock'),8000,'connection');
  const left=await sw.evaluate(()=>chrome.storage.local.get(['token','port','backend','custom']));
  assert.deepEqual(left,{});
  assert.equal(await panel.inputValue('#preset'),'Social Studies');
  assert.equal(await panel.inputValue('#wantWords'),'');                        // the old 120 is NOT carried over
  assert.match(await text('#sources'),/Notes\.txt/);
  await eventually('#last',/Last session stopped/);
  assert.match(await panel.locator('#log').textContent(),/Playback/);                                    // the old log is still readable
  await panel.fill('#brief','A note about rivers.');
  await panel.click('#more summary');await panel.check('#accelerate');
  await panel.click('#start');
  const s=await until(async()=>{const x=await session();return x&&x.state==='running'&&x.count===2?x:null;},15000,'new session');
  assert.equal(s.preset,'Social Studies');assert.equal(s.collection,'11111111-1111-4111-8111-111111111111');
  assert.equal('words' in (await planFetches())[0],false);
  await panel.click('#stop');
});

test('Start runs a whole session: types, revises an earlier sentence, reviews, finishes; Pause/Resume/Stop work',async()=>{
  await openPanel();
  await panel.fill('#brief','A short note about rivers.');
  await panel.click('#more summary');await panel.check('#accelerate');await panel.selectOption('#revisions','more');   // 100%: always revise
  await panel.click('#start');
  await until(async()=>(await session())?.state==='running','',0).catch(()=>{});
  await until(async()=>(await text('#run')).length>0&&await panel.locator('#run').isVisible(),10000,'run view');
  assert.equal(await panel.locator('#setup').isHidden(),true);
  assert.match(await text('#metrics'),/Paragraph \d of 2.*elapsed.*app-tracked.*ETA/);
  const first=await until(async()=>{const t=await docText();return t.length>10?t:null;},60000,'text appearing in the document');
  assert.ok(first.length>0);
  // pause immediately, then resume without duplicating anything
  await panel.click('#toggle');
  await until(async()=>(await session())?.state==='paused',8000,'paused');
  assert.equal(await text('#toggle'),'Resume');
  const frozen=await docText();await sleep(1200);assert.equal(await docText(),frozen);
  await panel.click('#toggle');
  const done=await until(async()=>{const s=await session();return s?.state==='done'?s:null;},120000,'session to finish').catch(async e=>{const s=await session();throw Error(e.message+' | state='+s?.state+' reason='+s?.reason+' at='+s?.at+'/'+s?.actions?.length+' doc='+JSON.stringify(await docText())+' log='+JSON.stringify((s?.log||[]).slice(-6)));});
  const final=await docText();
  const paragraphs=final.split('\n');
  assert.equal(paragraphs.length,2);
  // The mock's final-review edit targets a sentence that appears in BOTH paragraphs. An ambiguous edit must be refused, not guessed.
  assert.equal((final.match(/This is a draft summary\./g)||[]).length,2);
  assert.ok(paragraphs.every(p=>p.endsWith('This is a draft summary.')));
  assert.equal(final.includes('Paragraph 1 introduces one point from the reference.'),true);   // earlier sentence revised in place
  assert.equal(final.includes('Paragraph 2 introduces one point from the reference.'),true);
  assert.equal(final.includes('This is paragraph 1 of the example.'),false);                   // ...and the original is gone, not duplicated
  assert.equal(paidRequests(),2);                                                   // one plan + one final review, nothing more
  assert.ok(done.log.some(l=>/^Playback/.test(l))&&done.log.some(l=>/^Model/.test(l)));
  assert.equal(await panel.locator('#setup').isVisible(),true);                  // back to the simple screen
  assert.match(await text('#last'),/Last session finished/);
});

test('final review applies an unambiguous edit (one paragraph)',async()=>{
  await openPanel();
  await panel.fill('#brief','One paragraph about rivers.');
  await panel.click('#more summary');await panel.check('#accelerate');await panel.selectOption('#revisions','more');   // 100%: always revise
  await panel.click('#start');
  await until(async()=>(await session())?.state==='done',60000,'session to finish');
  assert.equal(await docText(),'Paragraph 1 introduces one point from the reference. This is a brief summary.');
  assert.equal(paidRequests(),2);
});

test('sources: a file attaches through the panel (no token) and a bad file is explained beside Sources',async()=>{
  await openPanel();
  await until(async()=>(await text('#mode')).includes('local mock'),8000,'connection');
  await panel.setInputFiles('#files',{name:'Notes.txt',mimeType:'text/plain',buffer:Buffer.from('A solar cell converts light into electricity.')});
  await eventually('#sources',/Notes\.txt/);
  assert.equal(await text('#err-sources'),'');
  assert.deepEqual((await sw.evaluate(()=>chrome.storage.local.get('fileNames'))).fileNames,['Notes.txt']);
  await panel.setInputFiles('#files',{name:'archive.zip',mimeType:'application/zip',buffer:Buffer.from('PK')});
  await eventually('#err-sources',/PDF, TXT or Markdown/);
  assert.equal(await panel.locator('#files').getAttribute('aria-invalid'),'true');
  await stopServer();
  await until(async()=>await panel.locator('#offline').isVisible(),10000,'offline banner');
  await panel.setInputFiles('#files',{name:'More.txt',mimeType:'text/plain',buffer:Buffer.from('x')});
  await eventually('#err-sources',/offline/);                                   // not silent when the backend is down
});
