import {keyDelay} from './pacing.js';
// Single plain-text Docs tab, desktop Ctrl shortcuts. All destructive edits verify
// both the document snapshot and selected passage before committing.
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const docId=url=>/^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]+)\/edit(?:[?#]|$)/.exec(url||'')?.[1];
export function transition(before,offset,old,text){
  if(!Number.isInteger(offset)||offset<0||offset>before.length||before.slice(offset,offset+old.length)!==old) throw Error('Draft changed at the proposed edit.');
  return before.slice(0,offset)+text+before.slice(offset+old.length);
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
    await cmd('Input.dispatchKeyEvent',{type:'rawKeyDown',...params});
    await cmd('Input.dispatchKeyEvent',{type:'keyUp',...params});
  }
  async function copySelected(){
    const marker='typingbot-'+crypto.randomUUID();await clip(marker);await key('c',2);
    for(let i=0;i<6;i++){await sleep(50);const value=await clip();if(value!==marker)return value;}
    return null;
  }
  async function snapshot(){
    await key('a',2);
    const result=await copySelected();
    await key('End',2); // collapse selection before any subsequent insertion
    return result;
  }
  try{
    await guard();await chrome.debugger.attach(target,'1.3');attached=true;
    const focus=await cmd('Runtime.evaluate',{expression:"!!document.activeElement?.matches('iframe.docs-texteventtarget-iframe')",returnByValue:true});
    if(!focus.result?.value)throw Error('Click the body of the Google Doc, then resume.');
    const before=await snapshot();
    if(before!==s.current && !(a.offset===0&&!a.old&&!s.current&&before===null)) throw Error('Document differs from the saved draft. Check it before continuing.');
    const expected=transition(s.current,a.offset,a.old,a.text);
    if(a.old){
      const tail=s.current.slice(a.offset+a.old.length);
      // Verify the actual selected string even when Docs counts a character differently.
      for(const _ of [...tail])await key('ArrowLeft');
      for(const _ of [...a.old])await key('ArrowLeft',8);
      if(await copySelected()!==a.old)throw Error('Selection did not match. Edit paused.');
    } else if(a.offset!==s.current.length)throw Error('Only appends are supported here.');
    let burst=0;
    for(const ch of a.text){
      if(/[a-z]/i.test(ch)&&Math.random()*100<s.typos){
        const wrong=String.fromCharCode(97+(ch.toLowerCase().charCodeAt(0)-96)%26);
        await cmd('Input.insertText',{text:wrong});await sleep(keyDelay(s)*1.5);
        await key('Backspace');await onProgress('Playback · corrected a simulated typo');
      }
      if(ch==='\n')await key('Enter');else await cmd('Input.insertText',{text:ch});
      await sleep(keyDelay(s));
      if(++burst>=Math.max(1,s.burst*5)){burst=0;await sleep(keyDelay(s)*(2+Math.random()*5));}
    }
    await sleep(120);
    if(await snapshot()!==expected)throw Error('Could not confirm the edit. Inspect the document.');
    return expected;
  }finally{if(attached)await chrome.debugger.detach(target).catch(()=>{});}
}
