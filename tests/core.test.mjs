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
  const validate=p=>validatePlan({paragraphs:[p]},{stage:'draft',count:1});
  for(const p of [{draft:'Go. Go.',old:'Go.',text:'Stay.'},{draft:'Go.',old:'Missing.',text:'Stay.'},{draft:'Go.',old:null,text:null},{draft:'Go.'}]){
    assert.deepEqual(validate(p).paragraphs,[{draft:p.draft,old:'',text:''}]);
  }
  assert.match(validate({draft:'Go.',old:'Missing.',text:'Stay.'}).note,/Skipped 1/);
  assert.deepEqual(validate({draft:'Go.\nStay.',old:'Go.',text:'Move.'}).paragraphs,[{draft:'Go. Stay.',old:'Go.',text:'Move.'}]);
  assert.throws(()=>validate({draft:' '}),/no draft text/);
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

test('live request binds the draft field and review edits to their respective response schemas',async()=>{
  const db=ledger(':memory:'),srv=app(db,{MODEL_MODE:'live',ANTHROPIC_API_KEY:'fixture'});
  const request=globalThis.fetch;
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  try{
    for(const stage of ['draft','review']){
      let config;
      globalThis.fetch=async(_,opts)=>{
        config=JSON.parse(opts.body).output_config;
        const plan=stage==='draft'?{paragraphs:[{draft:'Example.',old:'',text:''}]}:{edits:[]};
        return Response.json({stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:10},content:[{type:'text',text:JSON.stringify(plan)}]});
      };
      const response=await request('http://127.0.0.1:'+srv.address().port+'/plan',{method:'POST',headers:{Origin:ORIGIN},body:JSON.stringify({id:crypto.randomUUID(),run:crypto.randomUUID(),brief:'Example',preset:'English',stage,reference:'',draft:stage==='draft'?'':'Example.',runCents:10,dayCents:50})});
      assert.equal(response.status,200);assert.equal(config.format.type,'json_schema');
      const properties=config.format.schema.properties;
      assert.deepEqual(stage==='draft'?properties.paragraphs.items.required:properties.edits.items.required,stage==='draft'?['draft','old','text']:['old','text']);
    }
    assert.equal(validatePlan({paragraphs:['Example.']},{stage:'draft'}).paragraphs[0].draft,'Example.');
    assert.throws(()=>validatePlan({paragraphs:[{old:'X',text:'replacement only'}]},{stage:'draft'}),/no draft text/);
  }finally{globalThis.fetch=request;await new Promise(r=>srv.close(r));db.close();}
});
