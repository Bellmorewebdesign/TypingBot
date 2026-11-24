chrome.runtime.onMessage.addListener((m,_,reply)=>{
  if(m.for!=='clipboard')return;
  const box=document.querySelector('textarea');
  box.value=m.write??''; box.select();
  const ok=document.execCommand(m.write===undefined?'paste':'copy');
  reply({ok,value:box.value}); box.value='';
});
