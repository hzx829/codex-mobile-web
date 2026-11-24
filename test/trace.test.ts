import test from 'node:test';
import assert from 'node:assert/strict';
import {traced,step,stepSync} from '../src/connector/trace.js';

test('steps add up inside a traced request and cost nothing outside one', async () => {
  const {value,trace}=await traced(true,async()=>{
    await step('read',()=>new Promise(resolve=>setTimeout(resolve,5)));
    await step('read',()=>1);
    return stepSync('parse',()=>'done');
  });
  assert.equal(value,'done');
  assert.ok(trace!.handleMs>=4);
  assert.deepEqual(Object.keys(trace!.steps).sort(),['parse','read']);
  assert.ok(trace!.steps.read>=4);
  const plain=await traced(false,async()=>step('read',()=>2));
  assert.deepEqual(plain,{value:2});
  assert.equal(await step('outside',()=>3),3);
});

test('a failed step still counts its time and rethrows', async () => {
  const {trace}=await traced(true,async()=>{await step('fail',async()=>{throw Error('x');}).catch(()=>{});return 0;});
  assert.ok('fail' in trace!.steps);
});

test('the phone splits a traced request into links and work, and estimates the computer clock', async () => {
  (globalThis as any).localStorage={getItem:(key:string)=>key==='cmw-trace'?'1':null};
  try{
    const web=await import('../web/trace.js');
    // Sent at wall time 1000, answered after 100 ms; the relay waited 60 ms and the computer worked 20 ms,
    // finishing at 5010 on its clock. Its work's midpoint (5000) is matched to this request's (1050).
    web.recordRequest('session.read',0,100,1000,2048,{relayMs:60,handleMs:20,now:5010,steps:{read:15}});
    const [row]=web.summary();
    assert.equal(row.key,'request session.read');
    assert.deepEqual([row.p50,row.bytes50,row.phoneLink50,row.computerLink50,row.computer50,row['step.read50']],[100,2048,40,40,20,15]);
    assert.equal(web.clockOffset(),3950);
  }finally{delete (globalThis as any).localStorage;}
});
