import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {ledger,app,validatePlan,checkRequest,systemPrompt,mockShape,EXTENSION_ID} from '../server/main.ts';
const ORIGIN='chrome-extension://'+EXTENSION_ID;
const req=(port,{method='GET',path='/',headers={},body})=>new Promise((res,rej)=>{
  const r=http.request({host:'127.0.0.1',port,method,path,headers},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res({status:x.statusCode,body:d?JSON.parse(d):null}));});
  r.on('error',rej);r.end(body);
});
async function withServer(fn){
  const db=ledger(':memory:'),srv=app(db,{});await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  try{await fn(srv.address().port,db);}finally{await new Promise(r=>srv.close(r));db.close();}
}
const base={id:crypto.randomUUID(),run:crypto.randomUUID(),stage:'draft',preset:'English',brief:'Write about rivers',reference:'',draft:'',runCents:10,dayCents:50};

test('only the installed extension can read sources, change state or spend: other origins, no origin and rebinding hosts are refused',()=>withServer(async(port,db)=>{
  const post={method:'POST',path:'/plan',body:JSON.stringify(base)};
  for(const headers of [{},{Origin:'https://evil.example'},{Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'},{Origin:'null'}]){
    assert.equal((await req(port,{...post,headers})).status,403,JSON.stringify(headers));
    assert.equal((await req(port,{method:'POST',path:'/usage',headers})).status,403);
    assert.equal((await req(port,{method:'POST',path:'/health',headers})).status,403);
    assert.equal((await req(port,{method:'POST',path:'/source?id='+crypto.randomUUID()+'&name=a.txt',headers,body:'x'})).status,403);
  }
  assert.equal((await req(port,{...post,headers:{Origin:ORIGIN,Host:'evil.example:4317'}})).status,403);   // DNS rebinding
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n,0);                                    // nothing was spent or stored
  assert.equal((await req(port,{...post,headers:{Origin:ORIGIN}})).status,200);
  // liveness is public but reveals nothing about the setup to anyone but the extension
  assert.deepEqual((await req(port,{path:'/health'})).body,{ok:true});
  assert.equal((await req(port,{method:'POST',path:'/health',headers:{Origin:ORIGIN}})).body.mode,'mock');
  assert.equal((await req(port,{path:'/usage',headers:{Origin:ORIGIN}})).status,404);    // reads are POST-only: a GET gets no data
}));

test('no pairing token or backend setting is needed any more',()=>{
  assert.doesNotThrow(()=>app(ledger(':memory:'),{}));
});

test('length is optional: nothing about length is sent to the model unless the user gave it',async()=>{
  checkRequest(base);                                            // no count, no words: valid
  const none=systemPrompt(base);
  assert.doesNotMatch(none,/Write exactly|Aim for about/);
  assert.match(none,/choose a reasonable length yourself/);
  assert.doesNotMatch(none,/120/);
  assert.match(systemPrompt({...base,count:3,words:80}),/exactly 3 paragraph/);
  assert.match(systemPrompt({...base,count:3,words:80}),/about 80 words per paragraph/);
  assert.equal(JSON.stringify({a:undefined,b:1}),'{"b":1}');   // undefined fields are omitted from the user message
  assert.throws(()=>checkRequest({...base,count:9}),/Invalid/);
  assert.throws(()=>checkRequest({...base,words:5}),/Invalid/);
  assert.throws(()=>checkRequest({...base,count:0}),/Invalid/);
});

test('mock follows a length written in the brief, otherwise chooses its own, and an override wins',()=>{
  assert.deepEqual(mockShape({...base,brief:'about 300 words across three paragraphs'}),{count:3,sentences:10});
  assert.equal(mockShape({...base,brief:'Write about rivers'}).count,2);
  assert.equal(mockShape({...base,brief:'two paragraphs please'}).count,2);
  assert.equal(mockShape({...base,brief:'about 300 words across three paragraphs',count:1}).count,1);
});

test('plan validation accepts any model-chosen count within limits, exact count only when requested',()=>{
  const p=n=>({paragraphs:Array.from({length:n},(_,i)=>({draft:'Alpha '+i+'. Beta.',old:'Alpha '+i+'.',text:'Gamma.'})),note:'x'.repeat(500)});
  assert.equal(validatePlan(p(4),{stage:'draft'}).paragraphs.length,4);
  assert.equal(validatePlan(p(4),{stage:'draft'}).note.length,300);
  assert.throws(()=>validatePlan(p(4),{stage:'draft',count:3}),/paragraph count/);
  assert.throws(()=>validatePlan(p(0),{stage:'draft'}),/paragraph count/);
  assert.throws(()=>validatePlan(p(9),{stage:'draft'}),/paragraph count/);
});

test('through the server: brief with a word count and brief without one',()=>withServer(async(port)=>{
  const post=async b=>(await req(port,{method:'POST',path:'/plan',headers:{Origin:ORIGIN},body:JSON.stringify({...base,id:crypto.randomUUID(),run:crypto.randomUUID(),...b})})).body;
  const withLen=await post({brief:'about 300 words across three paragraphs'});
  assert.equal(withLen.paragraphs.length,3);
  const without=await post({brief:'a short piece about rivers'});
  assert.equal(without.paragraphs.length,2);
}));
