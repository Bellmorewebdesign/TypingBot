import {test} from 'node:test';
import assert from 'node:assert/strict';
import {edit,reconcile,continuation,transition} from '../extension/editor.js';

// Same functional double as editor.test.mjs (Chrome debugger + clipboard, not a real Docs tab), plus insertion-point support.
function fixture(initial){
  let text=initial,start=initial.length,end=initial.length,clipboard='',writes=0,backspaces=0;
  globalThis.chrome={
    runtime:{getContexts:async()=>[{}],sendMessage:async m=>{if(m.write!==undefined)clipboard=m.write;return {ok:true,value:clipboard};}},
    windows:{get:async()=>({focused:true})},tabs:{get:async()=>({active:true,url:'https://docs.google.com/document/d/fixture/edit',windowId:1})},
    debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async(_,name,p)=>{
      if(name==='Runtime.evaluate')return {result:{value:true}};
      if(name==='Input.insertText'){text=text.slice(0,start)+p.text+text.slice(end);start+=p.text.length;end=start;writes++;}
      if(p.type!=='rawKeyDown')return;
      switch(p.key){case 'a':start=0;end=text.length;break;case 'c':if(start!==end)clipboard=text.slice(start,end);break;
        case 'End':end=start=text.length;break;case 'ArrowLeft':start=Math.max(0,start-1);if(p.modifiers!==8)end=start;break;
        case 'Backspace':if(start!==end){text=text.slice(0,start)+text.slice(end);end=start;}else if(start>0){text=text.slice(0,start-1)+text.slice(start);start--;end=start;}backspaces++;break;}
    }}
  };
  return {text:()=>text,set:v=>{text=v;start=end=v.length;},writes:()=>writes};
}
const S={tab:1,doc:'fixture',typos:0,wpm:10000,variation:0,burst:100};
const run=(s,a,cancelled=()=>false)=>edit({...S,...s},a,cancelled);

test('reconcile classifies before / after / partial / unknown and never guesses',()=>{
  const a={offset:5,old:'',text:' world'};
  assert.equal(reconcile('Hello','Hello world','Hello world',a).kind,'after');
  assert.equal(reconcile('Hello','Hello world','Hello',a).kind,'before');
  assert.deepEqual(reconcile('Hello','Hello world','Hello wo',a),{kind:'partial',typed:3});
  assert.equal(reconcile('Hello','Hello world','Hello there',a).kind,'unknown');
  const r={offset:6,old:'cat',text:'dog'};
  assert.deepEqual(reconcile('A big cat.','A big dog.','A big .',r),{kind:'partial',typed:0});
  assert.deepEqual(reconcile('A big cat.','A big dog.','A big d.',r),{kind:'partial',typed:1});
  assert.equal(reconcile('A big cat.','A big dog.','A big bird.',r).kind,'unknown');
});

test('an interrupted append is completed once: the typed part is kept and nothing is duplicated',async()=>{
  const f=fixture('');
  const a={offset:0,old:'',text:'Hello brave new world.'};
  await assert.rejects(run({current:''},a,()=>f.writes()>=8),/Paused/);
  const partial=f.text();assert.equal(partial,'Hello br');
  const snap=await run({current:''},null);              // inspect only, as the worker does on Resume
  const r=reconcile('',transition('',0,'',a.text),snap,a);assert.deepEqual(r,{kind:'partial',typed:8});
  const next=continuation(a,r);assert.equal(next.text,'ave new world.');
  const done=await run({current:snap},next);
  assert.equal(done,'Hello brave new world.');assert.equal(f.text(),'Hello brave new world.');
});

test('an interrupted replacement of a repeated phrase resumes at the right occurrence',async()=>{
  const f=fixture('Red. Red. Red.');
  const a={offset:5,old:'Red.',text:'Blue.'};
  await assert.rejects(run({current:'Red. Red. Red.'},a,()=>f.writes()>=2),/Paused/);
  assert.equal(f.text(),'Red. Bl Red.');
  const snap=await run({current:'Red. Red. Red.'},null);
  const r=reconcile('Red. Red. Red.','Red. Blue. Red.',snap,a);assert.equal(r.kind,'partial');
  const done=await run({current:snap},continuation(a,r));
  assert.equal(done,'Red. Blue. Red.');
});

test('if the edit had in fact finished, resume does nothing and does not type it again',async()=>{
  const f=fixture('');
  const a={offset:0,old:'',text:'Done.'};
  await run({current:''},a);const writes=f.writes();
  const snap=await run({current:''},null);
  assert.equal(reconcile('','Done.',snap,a).kind,'after');
  assert.equal(f.writes(),writes);
});

test('insertion in the middle of the text (deleted-then-interrupted replacement)',async()=>{
  const f=fixture('A big .');
  const next=continuation({offset:6,old:'cat',text:'dog',label:'Revise wording',p:1},{kind:'partial',typed:0});
  assert.deepEqual([next.old,next.text],['','dog']);
  assert.equal(await run({current:'A big .'},next),'A big dog.');
  assert.equal(f.text(),'A big dog.');
});

test('a document changed by someone else is refused before anything is typed',async()=>{
  const f=fixture('Hello');f.set('Hello (edited by someone)');
  await assert.rejects(run({current:'Hello'},{offset:5,old:'',text:' world'}),/differs/);assert.equal(f.writes(),0);
});
