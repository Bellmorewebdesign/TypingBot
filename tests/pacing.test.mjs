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
