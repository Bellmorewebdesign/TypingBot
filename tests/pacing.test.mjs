import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,keyDelay,conflicts,etaSeconds,scheduledDelay} from '../extension/pacing.js';

test('typing speed stays inside the configured minimum and maximum',()=>{
  const s={...defaults.English,variation:90};
  for(let i=0;i<500;i++){const d=keyDelay(s);assert.ok(d>=12000/s.maxWpm-1e-9&&d<=12000/s.minWpm+1e-9,String(d));}
});
test('conflicting settings are flagged before a run starts',()=>{
  assert.ok(conflicts({...defaults.English,count:1,runCents:10,dayCents:50,minWpm:60,wpm:40}).some(x=>x.level==='error'));
  const w=conflicts({...defaults.English,count:3,runCents:10,dayCents:50});
  assert.ok(w.every(x=>x.level==='warn')&&w.some(x=>/3\.0 hours/.test(x.message)));
  assert.ok(conflicts({...defaults.English,count:1,runCents:20,dayCents:10}).some(x=>/daily/.test(x.message)));
  assert.ok(conflicts({...defaults.English,count:1,runCents:10,dayCents:50,minMinutes:1,longSeconds:240}).some(x=>/long break/i.test(x.message)));
});
test('ELA defaults are slower and revise more than Social Studies',()=>{
  const e=defaults.English,s=defaults['Social Studies'];
  assert.ok(e.wpm<s.wpm&&e.reviewRate>s.reviewRate&&e.sentencePause>s.sentencePause);
});
test('ETA is null while paused and includes long breaks; paragraph minimum is a floor',()=>{
  const base={...defaults.English,count:2,at:0,actions:[{text:'Hello there.',label:'Insert sentence',p:1}],reviewed:false};
  assert.equal(etaSeconds({...base,state:'paused'}),null);
  const t=etaSeconds({...base,state:'running'});assert.ok(t>=2*3600-1);
  assert.ok(scheduledDelay({...base,activeParagraph:Date.now()},{p:1})>=0);
});

import {resolve,paces,revisions} from '../extension/pacing.js';
test('simple controls resolve to the detailed numbers; presets own the fine details',()=>{
  const base=defaults.English,std=resolve({preset:'English',pace:'standard',revisions:'standard',minimum:'preset',runCents:10,dayCents:50});
  assert.equal(std.wpm,base.wpm);assert.equal(std.minMinutes,60);assert.equal(std.reviewRate,base.reviewRate);
  assert.equal(std.count,undefined);assert.equal(std.words,undefined);                       // no length is invented
  const slow=resolve({preset:'English',pace:'slower',revisions:'less',minimum:'none',runCents:10,dayCents:50});
  const fast=resolve({preset:'English',pace:'faster',revisions:'more',minimum:'half',runCents:10,dayCents:50});
  assert.ok(slow.wpm<std.wpm&&std.wpm<fast.wpm);assert.ok(slow.sentencePause>std.sentencePause);
  assert.ok(slow.reviewRate<std.reviewRate&&fast.reviewRate<=100);assert.equal(slow.minMinutes,0);assert.equal(fast.minMinutes,30);
  for(const s of [slow,std,fast])assert.deepEqual(conflicts({...s,count:1}).filter(x=>x.level==='error'),[]);   // presets never conflict
  assert.ok(resolve({preset:'Social Studies',pace:'standard',revisions:'standard',minimum:'preset',runCents:10,dayCents:50}).wpm>base.wpm);
});
test('accelerated test mode removes the minimum and the scheduled pauses but keeps revisions',()=>{
  const s=resolve({preset:'English',pace:'standard',revisions:'standard',minimum:'preset',accelerate:true,runCents:10,dayCents:50});
  assert.equal(s.minMinutes,0);assert.equal(s.sentencePause,0);assert.equal(s.breakChance,0);assert.ok(s.reviewRate>0);
  assert.ok(s.minWpm<=s.wpm&&s.wpm<=s.maxWpm);
});
