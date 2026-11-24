import {test} from 'node:test';
import assert from 'node:assert/strict';
import {edit} from '../extension/editor.js';

// A functional double for the Chrome debugger and clipboard, not a Docs browser test.
function fixture(initial){
  let text=initial,start=0,end=0,clipboard='',writes=0;
  globalThis.chrome={
    runtime:{getContexts:async()=>[{}],sendMessage:async m=>{if(m.write!==undefined)clipboard=m.write;return {ok:true,value:clipboard};}},
    windows:{get:async()=>({focused:true})},tabs:{get:async()=>({active:true,url:'https://docs.google.com/document/d/fixture/edit',windowId:1})},
    debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async(_,name,p)=>{
      if(name==='Runtime.evaluate')return {result:{value:true}};
      if(name==='Input.insertText'){text=text.slice(0,start)+p.text+text.slice(end);start+=p.text.length;end=start;writes++;}
      if(p.type==='keyDown'&&p.text==='\r'){text=text.slice(0,start)+'\n'+text.slice(end);start+=1;end=start;writes++;return;}
      if(p.type!=='rawKeyDown')return;
      switch(p.key){case 'a':start=0;end=text.length;break;case 'c':if(start!==end)clipboard=text.slice(start,end);break;
        case 'End':end=start=text.length;break;case 'ArrowLeft':start=Math.max(0,start-1);if(p.modifiers!==8)end=start;break;}
    }}
  };
  return {text:()=>text,writes:()=>writes};
}
const session={tab:1,doc:'fixture',typos:0,wpm:10000,variation:0,burst:100};
test('append then revise the intended repeated occurrence; unrelated text survives',async()=>{
  const f=fixture('');
  const current=await edit({...session,current:''},{offset:0,old:'',text:'Red. Red.'},()=>false);
  assert.equal(await edit({...session,current},{offset:0,old:'Red.',text:'Blue.'},()=>false),'Blue. Red.');
  assert.equal(f.text(),'Blue. Red.');
});
test('unexpected document change aborts before typing',async()=>{
  const f=fixture('User edit.');
  await assert.rejects(edit({...session,current:'Old.'},{offset:4,old:'',text:' More.'},()=>false),/differs/);assert.equal(f.writes(),0);
});
test('pause stops further characters after an interrupted action',async()=>{
  const f=fixture('A');
  await assert.rejects(edit({...session,current:'A'},{offset:1,old:'',text:'XYZ'},()=>f.writes()>0),/Paused/);
  assert.equal(f.text(),'AX');
});
