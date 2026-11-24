import test from 'node:test';
import assert from 'node:assert/strict';
import {ledger,app,reserve,validatePlan,EXTENSION_ID} from '../server/main.ts';
const ORIGIN='chrome-extension://'+EXTENSION_ID;
import {transition,docId} from '../extension/editor.js';
import {scheduledDelay,defaults} from '../extension/pacing.js';
test('budget reservations survive duplicate calls, include pending usage and check daily total',()=>{
  const db=ledger(':memory:');const a={id:'one',run:'session1'};
  reserve(db,a,'a',60,100,100);
  assert.throws(()=>reserve(db,a,'a',60,100,100),/uncertain/);
  assert.throws(()=>reserve(db,{id:'other',run:'session2'},'b',50,100,100),/Budget/);
  db.prepare('UPDATE calls SET cost=5,result=?').run('{"ok":true}');
  assert.deepEqual(reserve(db,a,'a',60,100,100),{ok:true});db.close();
});
test('mock server accepts only the installed extension and returns repeatable plans and a whole-document review',async()=>{
  const db=ledger(':memory:'),srv=app(db,{});await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+srv.address().port;
  try{
    assert.equal((await fetch(url+'/plan',{method:'POST',body:'{}'})).status,403);
    const a={id:crypto.randomUUID(),run:crypto.randomUUID(),stage:'draft',preset:'English',brief:'Explain this example',reference:'A fixture',draft:'',count:1,runCents:10,dayCents:50};
    const post=async body=>await (await fetch(url+'/plan',{method:'POST',headers:{Origin:ORIGIN},body:JSON.stringify(body)})).json();
    const draft=await post(a);assert.equal(draft.cost,0);assert.equal(draft.paragraphs.length,1);assert.deepEqual(await post(a),draft);
    assert.equal((await post({...a,id:crypto.randomUUID(),stage:'review',draft:draft.paragraphs[0].draft})).edits.length,1);
    assert.equal((await post({...a,runCents:11})).error,'Invalid budget.');
  }finally{await new Promise(r=>srv.close(r));db.close();}
});
test('an ambiguous first-pass revision is rejected and repeated text is edited by position',()=>{
  assert.throws(()=>validatePlan({paragraphs:[{draft:'Go. Go.',old:'Go.',text:'Stay.'}]},{stage:'draft',count:1}));
  assert.equal(transition('Go. Go.',4,'Go.','Stay.'),'Go. Stay.');
  assert.throws(()=>transition('Stop.',0,'Go.','No.'));
  assert.equal(docId('https://docs.google.com/document/d/abc/edit'),'abc');
  assert.equal(docId('https://example.com/document/d/abc/edit'),undefined);
});
test('paragraph floor includes active time and final review is exempt',()=>{
  const s={...defaults.English,actions:[],at:0,activeParagraph:Date.now(),reviewed:false};
  assert.ok(scheduledDelay(s,{p:1})>3599000);
  assert.ok(scheduledDelay({...s,reviewed:true},{p:1})<3600000);
});
