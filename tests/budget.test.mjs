import test from 'node:test';
import assert from 'node:assert/strict';
import {ledger,reserve,app,MODELS,usageCost,EXTENSION_ID} from '../server/main.ts';
const ORIGIN='chrome-extension://'+EXTENSION_ID;

test('budget: per-run and daily ceilings are enforced across runs, before dispatch',()=>{
  const db=ledger(':memory:');
  reserve(db,{id:'1',run:'A'},'f',60,100,150);
  assert.throws(()=>reserve(db,{id:'2',run:'A'},'f',60,100,150),/Budget/);          // would exceed run limit (120>100)
  reserve(db,{id:'3',run:'B'},'f',60,100,150);                                      // other run is fine, daily total now 120
  assert.throws(()=>reserve(db,{id:'4',run:'C'},'f',60,100,150),/Budget/);          // daily 180>150
  db.close();
});
test('budget: concurrent requests cannot both be admitted against the same remaining budget',async()=>{
  const db=ledger(':memory:');
  const results=await Promise.allSettled([1,2,3,4,5].map(async i=>reserve(db,{id:'c'+i,run:'R'},'f',40,100,1000)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);                 // 40+40=80 fits, a third (120) does not
  db.close();
});
test('budget: a failed or uncertain call keeps its reservation, so retries cannot overspend',()=>{
  const db=ledger(':memory:');
  reserve(db,{id:'x',run:'R'},'f',90,100,1000);
  assert.throws(()=>reserve(db,{id:'x',run:'R'},'f',90,100,1000),/pending or uncertain/);
  assert.throws(()=>reserve(db,{id:'y',run:'R'},'f',20,100,1000),/Budget/);
  db.close();
});
test('cost uses every billed token class, per model',()=>{
  const h=MODELS['claude-haiku-5-5'];
  assert.equal(usageCost(h,{input_tokens:1000,output_tokens:1000}),1000*100+1000*500);          // $0.0006
  assert.equal(usageCost(h,{input_tokens:0,output_tokens:0,cache_creation_input_tokens:1000,cache_read_input_tokens:1000}),1000*125+1000*10);
  assert.ok(MODELS['claude-sonnet-5-5'].output>h.output);
});
test('live mode refuses an unpriced model rather than guessing, and never switches model',()=>{
  const db=ledger(':memory:'),base={MODEL_MODE:'live',ANTHROPIC_API_KEY:'k'};
  assert.throws(()=>app(db,{...base,ANTHROPIC_MODEL:'claude-mystery-9'}),/must be one of/);
  assert.doesNotThrow(()=>app(db,{...base,ANTHROPIC_MODEL:'claude-sonnet-5-5'}));
  db.close();
});
test('usage endpoint reports app-tracked spend only and requires the installed extension',async()=>{
  const db=ledger(':memory:'),srv=app(db,{});await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+srv.address().port;
  try{
    assert.equal((await fetch(url+'/usage',{method:'POST'})).status,403);
    const u=await (await fetch(url+'/usage',{method:'POST',headers:{Origin:ORIGIN}})).json();
    assert.equal(u.scope,'app-tracked only');assert.equal(u.dayUsd,0);
  }finally{await new Promise(r=>srv.close(r));db.close();}
});
