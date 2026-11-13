import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DraftSave} from '../web/draft-save.js';

test('typing coalesces writes; flush and thread changes preserve the latest draft exactly once',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const saved:[string,string][]=[];const draft=new DraftSave((key,text)=>saved.push([key,text]));
  for(let i=0;i<100;i++)draft.write('first',`draft ${i}`);
  assert.equal(saved.length,0);t.mock.timers.tick(300);assert.deepEqual(saved,[['first','draft 99']]);
  draft.write('first','before navigation');draft.write('second','new thread');
  assert.deepEqual(saved.at(-1),['first','before navigation']);
  draft.flush();draft.flush();t.mock.timers.tick(300);
  assert.deepEqual(saved.at(-1),['second','new thread']);assert.equal(saved.length,3);
  draft.write('second','send now');draft.flush();saved.push(['second','']);
  t.mock.timers.tick(1000);assert.deepEqual(saved.at(-1),['second',''],'A delayed timer must not restore a sent draft.');
});
