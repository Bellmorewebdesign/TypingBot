import {keyDelay} from './pacing.js';
// Single plain-text Docs tab, desktop Ctrl shortcuts. All destructive edits verify
// both the document snapshot and selected passage before committing.
// Nearby letter keys on a US QWERTY keyboard.
const nearby={q:'wa',w:'qeas',e:'wrsd',r:'etdf',t:'ryfg',y:'tugh',u:'yihj',i:'uojk',o:'ipkl',p:'ol',a:'qwsz',s:'awedxz',d:'serfcx',f:'drtgvc',g:'ftyhbv',h:'gyujnb',j:'huikmn',k:'jiolm',l:'kop',z:'asx',x:'zsdc',c:'xdfv',v:'cfgb',b:'vghn',n:'bhjm',m:'njk'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const docId=url=>/^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]+)\/edit(?:[?#]|$)/.exec(url||'')?.[1];
export function transition(before,offset,old,text){
  if(!Number.isInteger(offset)||offset<0||offset>before.length||before.slice(offset,offset+old.length)!==old) throw Error('Draft changed at the proposed edit.');
  return before.slice(0,offset)+text+before.slice(offset+old.length);
}
const spaces = text => text.replace(/\u00a0/g,' ');
function matchesCopy(actual,expected){
  return typeof actual==='string' && (spaces(actual)===spaces(expected) || spaces(actual)===spaces(expected)+'\n');
}
function firstSpace(before,action,copy){
  return before==='' && action?.offset===0 && action.old==='' && matchesCopy(copy,' ');
}
function difference(actual,expected){
  if(actual===null)return 'Docs did not return any clipboard text.';
  const a=spaces(actual),b=spaces(expected);
  let i=0;while(i<a.length && i<b.length && a[i]===b[i])i++;
  return 'First difference at character '+(i+1)+': expected '+JSON.stringify(expected.slice(i,i+20))+
    ', copied '+JSON.stringify(actual.slice(i,i+20))+'.';
}
// Classify what an interrupted edit left behind. Never guesses: anything unrecognised is 'unknown' and needs a person.
export function reconcile(before,after,snap,a){
  if(snap===after)return {kind:'after'};
  if(snap===before)return {kind:'before'};
  if(matchesCopy(snap,after))return {kind:'after'};
  if(firstSpace(before,a,snap))return {kind:'before'};
  if(matchesCopy(snap,before))return {kind:'before'};
  if(!a.old && a.offset===before.length && before.endsWith(' ') && matchesCopy(snap,before.slice(0,-1)))return {kind:'before'};
  const head=before.slice(0,a.offset),tail=before.slice(a.offset+a.old.length);
  if(snap.startsWith(head)&&snap.endsWith(tail)&&snap.length>=head.length+tail.length){
    const mid=snap.slice(head.length,snap.length-tail.length);
    // a.old deleted (mid==='') or part of a.text typed so far
    if(a.old&&mid==='')return {kind:'partial',typed:0};
    if(mid.length>0&&mid.length<a.text.length&&a.text.startsWith(mid))return {kind:'partial',typed:mid.length};
  }
  return {kind:'unknown'};
}
// Turn a partial edit into the smallest safe follow-up action, with the observed document as the new baseline.
export function continuation(a,partial){
  const done=a.text.slice(0,partial.typed);
  if(!a.old)return {...a,offset:a.offset+partial.typed,old:'',text:a.text.slice(partial.typed)};      // append: type the rest
  if(partial.typed===0)return {...a,old:'',text:a.text};                                                   // deleted only: insert at offset
  return {...a,old:done,text:a.text};                                                                      // select what was typed, retype it all
}
async function clip(write){
  if(!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length) await chrome.offscreen.createDocument({url:'clipboard.html',reasons:['CLIPBOARD'],justification:'Verify the selected Google Docs text before an edit.'});
  const r=await chrome.runtime.sendMessage({for:'clipboard',write});
  if(!r?.ok)throw Error('Clipboard verification unavailable.');
  return r.value.replace(/\r\n/g,'\n');
}
export async function edit(s,a,cancelled,onProgress=async()=>{}) {
  const target={tabId:s.tab}; let attached=false;
  async function guard(){
    if(cancelled())throw Error('Paused. Check the document before resuming.');
    const tab=await chrome.tabs.get(s.tab);
    if(!tab.active||docId(tab.url)!==s.doc||!(await chrome.windows.get(tab.windowId)).focused)throw Error('Bring the linked document window to the front.');
  }
  async function cmd(name,params){await guard();return chrome.debugger.sendCommand(target,name,params);}
  const codes={a:65,c:67,End:35,ArrowLeft:37,Backspace:8,Enter:13};
  async function key(k,modifiers=0){
    const params={key:k,code:k.length===1?'Key'+k.toUpperCase():k,windowsVirtualKeyCode:codes[k],modifiers};
    // Give the Docs frame a one-use marker so manual key presses can interrupt.
    const marker=JSON.stringify({key:k,ctrl:modifiers===2,shift:modifiers===8,expires:Date.now()+1000});
    await cmd('Runtime.evaluate',{expression:"document.activeElement?.setAttribute('data-typingbot-key',"+JSON.stringify(marker)+")"});
    // Enter must carry its character: a bare rawKeyDown does not insert a paragraph break.
    const down=k==='Enter'?{type:'keyDown',text:'\r',unmodifiedText:'\r'}:{type:'rawKeyDown'};
    await cmd('Input.dispatchKeyEvent',{...down,...params});
    await cmd('Input.dispatchKeyEvent',{type:'keyUp',...params});
  }
  async function copySelected(){
    const marker='typingbot-'+crypto.randomUUID();await clip(marker);await key('c',2);
    for(let i=0;i<6;i++){await sleep(50);const value=await clip();if(value!==marker)return value;}
    return null;
  }
  async function snapshot(initialAction=null){
    await key('a',2);
    const result=await copySelected();
    // Keep this verified one-space selection so the first keystroke replaces it.
    // Every other read collapses the selection, including inspection on Resume.
    if(!firstSpace(s.current,initialAction,result))await key('End',2);
    return result;
  }
  try{
    await guard();await chrome.debugger.attach(target,'1.3');attached=true;
    const focus=await cmd('Runtime.evaluate',{expression:"!!document.activeElement?.matches('iframe.docs-texteventtarget-iframe')",returnByValue:true});
    if(!focus.result?.value)throw Error('Click the body of the Google Doc, then resume.');
    let before=await snapshot(a);
    if(a===null)return before; // inspect only: used to reconcile after an interruption
    if(firstSpace(s.current,a,before))before='';
    let prefix='';
    if(!matchesCopy(before,s.current) && !a.old && a.offset===s.current.length && s.current.endsWith(' ') && matchesCopy(before,s.current.slice(0,-1))){
      // Inspect the physical last character: copying a selection can omit a trailing space.
      await key('ArrowLeft',8);
      const last=await copySelected();
      await key('End',2);
      if(last===' ' || last==='\u00a0') before=s.current;
      else if(last && last===s.current.slice(-2,-1)){prefix=' ';before=s.current;}
    }
    if(!matchesCopy(before,s.current) && !(a.offset===0&&!a.old&&!s.current&&before===null)) throw Error('Document differs from the saved draft. '+difference(before,s.current));
    const expected=transition(s.current,a.offset,a.old,a.text);
    if(a.old){
      const tail=s.current.slice(a.offset+a.old.length);
      // Verify the actual selected string even when Docs counts a character differently.
      for(const _ of [...tail])await key('ArrowLeft');
      for(const _ of [...a.old])await key('ArrowLeft',8);
      if(spaces((await copySelected())??'')!==spaces(a.old))throw Error('Selection did not match. Edit paused.');
    } else if(a.offset>s.current.length)throw Error('Edit offset is beyond the document.');
    else for(const _ of [...s.current.slice(a.offset)])await key('ArrowLeft'); // insertion point inside the text
    let burst=0;
    const letters=[...(prefix+a.text)];
    for(let i=0;i<letters.length;i++){
      const ch=letters[i],neighbors=nearby[ch.toLowerCase()];
      if(neighbors && Math.random()*100<s.typos){
        const adjacent=neighbors[Math.floor(Math.random()*neighbors.length)];
        const wrong=ch===ch.toUpperCase()?adjacent.toUpperCase():adjacent;
        await cmd('Input.insertText',{text:wrong});
        // Sometimes notice a slip one or two letters into the rest of the word.
        let extra=0;
        while(extra<2 && /^[a-z]$/i.test(letters[i+extra+1]||'') && Math.random()<0.5){
          await sleep(keyDelay(s));
          await cmd('Input.insertText',{text:letters[i+extra+1]});
          extra++;
        }
        await sleep((s.typoDelay||keyDelay(s)*1.5)*(0.7+Math.random()*0.8));
        for(let n=0;n<=extra;n++){
          await key('Backspace');
          if(n<extra)await sleep(keyDelay(s)*0.5);
        }
        await onProgress('Playback · corrected a simulated typo');
      }
      if(ch==='\n')await key('Enter');else await cmd('Input.insertText',{text:ch});
      await sleep(keyDelay(s));
      if(s.punctPause&&/[,;:.!?]/.test(ch))await sleep(s.punctPause*1000*(0.5+Math.random()));
      if(++burst>=Math.max(1,s.burst*5)){burst=0;await sleep(keyDelay(s)*(2+Math.random()*5));}
    }
    await sleep(120);
    const copied=await snapshot();
    if(!matchesCopy(copied,expected))throw Error('Could not confirm the edit. '+difference(copied,expected));
    return expected;
  }finally{if(attached)await chrome.debugger.detach(target).catch(()=>{});}
}
