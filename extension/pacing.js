export const defaults={
  English:{wpm:38,variation:30,typos:2,burst:6,sentencePause:14,breakChance:12,breakSeconds:85,revisit:2,minMinutes:60,reviewRate:95},
  'Social Studies':{wpm:54,variation:20,typos:1,burst:10,sentencePause:6,breakChance:8,breakSeconds:55,revisit:3,minMinutes:60,reviewRate:60}
};
export function etaSeconds(s){
  if(s.state!=='running'&&s.state!=='ready')return null;
  const remaining=s.actions.slice(s.at);
  const write=remaining.reduce((sum,a)=>sum+(a.text.length*12/s.wpm)+(a.label==='Insert sentence'?s.sentencePause:1),0);
  const p=remaining[0]?.p??s.count;
  const floor=s.activeParagraph?(Math.max(0,s.minMinutes*60-(Date.now()-s.activeParagraph)/1000)+(s.count-p)*s.minMinutes*60):s.count*s.minMinutes*60;
  const estimate=Math.max(s.reviewed?0:floor,write+remaining.length*s.breakChance/100*s.breakSeconds);
  return Math.max(0,estimate+(s.finalReview&&!s.reviewed?15:0));
}
export function keyDelay(s){return 12000/s.wpm*(1+(Math.random()*2-1)*s.variation/100);}
export function scheduledDelay(s,a){
  const next=s.actions[s.at],last=!next||next.p!==a.p;
  const factor=0.65+Math.random()*.7;
  const rest=last||a.label==='Insert sentence'?s.sentencePause*factor:1;
  const plannedBreak=Math.random()*100<s.breakChance?s.breakSeconds*factor:0;
  const floor=last&&!s.reviewed?Math.max(0,s.activeParagraph+s.minMinutes*60000-Date.now()):0;
  const left=s.actions.slice(s.at).filter(x=>x.p===a.p).length;
  const spread=(!s.reviewed&&left&&s.minMinutes)?Math.max(0,(s.activeParagraph+s.minMinutes*60000-Date.now())/(left+1))*factor:0;
  return Math.max(floor,spread,(rest+plannedBreak)*1000);
}
