function takeover(){chrome.runtime.sendMessage({takeover:true}).catch(()=>{});}
addEventListener('pointerdown',takeover,true);
addEventListener('keydown',e=>{
  const frame=window.frameElement||document.activeElement;
  let marker;
  try{marker=JSON.parse(frame?.getAttribute('data-typingbot-key')||'null');}catch{}
  frame?.removeAttribute('data-typingbot-key');
  if(marker && marker.key===e.key && marker.ctrl===e.ctrlKey && marker.shift===e.shiftKey && Date.now()<marker.expires)return;
  takeover();
},true);
