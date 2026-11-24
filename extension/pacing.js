export const defaults={
  English:{wpm:38,minWpm:22,maxWpm:58,variation:30,typos:2,typoDelay:450,burst:6,punctPause:0.6,sentencePause:14,breakChance:12,breakSeconds:85,longChance:3,longSeconds:240,revisit:2,minMinutes:60,reviewRate:95},
  'Social Studies':{wpm:54,minWpm:36,maxWpm:80,variation:20,typos:1,typoDelay:300,burst:10,punctPause:0.3,sentencePause:6,breakChance:8,breakSeconds:55,longChance:1,longSeconds:150,revisit:3,minMinutes:60,reviewRate:60}
};
export function etaSeconds(s){
  if(s.state!=='running'&&s.state!=='ready')return null;
  const remaining=s.actions.slice(s.at);
  const write=remaining.reduce((sum,a)=>sum+(a.text.length*12/s.wpm)+(a.label==='Insert sentence'?s.sentencePause:1),0);
  const p=remaining[0]?.p??s.count;
  const floor=s.activeParagraph?(Math.max(0,s.minMinutes*60-(Date.now()-s.activeParagraph)/1000)+(s.count-p)*s.minMinutes*60):s.count*s.minMinutes*60;
  const estimate=Math.max(s.reviewed?0:floor,write+remaining.length*(s.breakChance/100*s.breakSeconds+(s.longChance||0)/100*(s.longSeconds||0)));
  return Math.max(0,estimate+(s.finalReview&&!s.reviewed?15:0));
}
// Per-key delay in ms, clamped to the configured minimum and maximum typing speed.
export function keyDelay(s){
  const d=12000/s.wpm*(1+(Math.random()*2-1)*s.variation/100);
  return Math.min(s.minWpm?12000/s.minWpm:Infinity,Math.max(s.maxWpm?12000/s.maxWpm:0,d));
}
export function scheduledDelay(s,a){
  const next=s.actions[s.at],last=!next||next.p!==a.p;
  const factor=0.65+Math.random()*.7;
  const rest=last||a.label==='Insert sentence'?s.sentencePause*factor:1;
  const roll=Math.random()*100,plannedBreak=roll<(s.longChance||0)?s.longSeconds*factor:roll<(s.longChance||0)+s.breakChance?s.breakSeconds*factor:0;
  const floor=last&&!s.reviewed?Math.max(0,s.activeParagraph+s.minMinutes*60000-Date.now()):0;
  const left=s.actions.slice(s.at).filter(x=>x.p===a.p).length;
  const spread=(!s.reviewed&&left&&s.minMinutes)?Math.max(0,(s.activeParagraph+s.minMinutes*60000-Date.now())/(left+1))*factor:0;
  return Math.max(floor,spread,(rest+plannedBreak)*1000);
}

// Checked before a plan is requested. Errors block the run; warnings are shown and the run may proceed.
export function conflicts(s){
  const out=[],err=m=>out.push({level:'error',message:m}),warn=m=>out.push({level:'warn',message:m});
  if(!(s.minWpm<=s.wpm&&s.wpm<=s.maxWpm))err('Typing speed must satisfy minimum <= average <= maximum.');
  if(s.minMinutes>0&&s.longSeconds>s.minMinutes*60)warn('A long break ('+s.longSeconds+' s) is longer than the paragraph minimum ('+s.minMinutes+' min); the paragraph minimum will be exceeded.');
  if(s.breakSeconds>s.longSeconds&&s.longChance>0)warn('Short breaks are set longer than long breaks.');
  if(s.minMinutes>0&&s.count){
    const hours=s.count*s.minMinutes/60;
    if(hours>=1)warn(s.count+' paragraph(s) at a '+s.minMinutes+' minute minimum take at least '+hours.toFixed(1)+' hours. Keep the computer awake and the Docs tab in front, or use Accelerate for testing.');
  }
  if(s.minMinutes===0&&s.wpm>=120&&s.sentencePause===0&&s.breakChance===0)warn('Test timing is active: no minimum paragraph time and no scheduled pauses.');
  if(s.runCents>s.dayCents)warn('The per-run limit is higher than the daily limit; the daily limit will apply first.');
  return out;
}

// ---- Simple controls -> the detailed numbers the editor uses. Presets own the fine details. ----
export const paces={slower:{label:'Slower',f:0.75},standard:{label:'Preset pace',f:1},faster:{label:'Faster',f:1.35}};
export const revisions={less:{label:'Rarely',f:0.4},standard:{label:'Preset amount',f:1},more:{label:'Often',f:1.4}};
export const minimums={preset:{label:'Preset (1 hour)'},none:{label:'No minimum'},half:{label:'30 minutes'}};
// Accelerated test mode: runs finish in minutes, with no minimum paragraph time.
const fast={minMinutes:0,sentencePause:0,breakChance:0,longChance:0,punctPause:0,wpm:180,minWpm:100,maxWpm:300,typoDelay:100};
export function resolve(o){
  const base={...(defaults[o.preset]||defaults.English)},p=paces[o.pace]||paces.standard,r=revisions[o.revisions]||revisions.standard;
  const s={...base,wpm:base.wpm*p.f,minWpm:base.minWpm*p.f,maxWpm:base.maxWpm*p.f,sentencePause:base.sentencePause/p.f,reviewRate:Math.min(100,Math.round(base.reviewRate*r.f))};
  if(o.minimum==='none')s.minMinutes=0;else if(o.minimum==='half')s.minMinutes=30;
  if(o.accelerate)Object.assign(s,fast);
  return {...s,preset:o.preset,revise:s.reviewRate>0,finalReview:o.finalReview!==false,runCents:o.runCents,dayCents:o.dayCents,count:o.count,words:o.words};
}
