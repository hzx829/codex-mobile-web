import {test} from 'node:test';
import assert from 'node:assert/strict';
import {revertThread} from '../src/connector/revert.js';
import {BridgeError} from '../src/shared/types.js';

test('paginated edits use the selected turn with thread/revert',async()=>{
  const calls:any[]=[];
  await revertThread({async rpc(method,params){calls.push({method,params});}},{id:'s',historyMode:'paginated'},'chosen',2);
  assert.deepEqual(calls,[{method:'thread/revert',params:{threadId:'s',beforeTurnId:'chosen'}}]);
});

test('legacy compatibility releases the current runtime, rolls back without inference, and reloads current settings',async()=>{
  const calls:any[]=[];
  const legacy={async start(){calls.push('legacy/start');},async rpc(method:string,params:any){assert.notEqual(method,'turn/start');calls.push({runtime:'legacy',method,params});},close(){calls.push('legacy/close');}};
  const runtime={legacyRuntime:()=>legacy,async rpc(method:string,params:any){
    calls.push({runtime:'current',method,params});
    if(method==='thread/rollback')throw new BridgeError('runtime_error','unknown variant `thread/rollback`');
    if(method==='thread/resume')return {model:'gpt-6-astra',modelProvider:'openai',approvalPolicy:'never',reasoningEffort:'ultra'};
  }};
  await revertThread(runtime,{id:'s',historyMode:'legacy'},'chosen',2);
  assert.deepEqual(calls.slice(2),[
    'legacy/start',
    {runtime:'current',method:'thread/unsubscribe',params:{threadId:'s'}},
    {runtime:'legacy',method:'thread/resume',params:{threadId:'s'}},
    {runtime:'legacy',method:'thread/rollback',params:{threadId:'s',numTurns:2}},
    {runtime:'legacy',method:'thread/unsubscribe',params:{threadId:'s'}},
    {runtime:'current',method:'thread/resume',params:{threadId:'s',model:'gpt-6-astra',modelProvider:'openai',approvalPolicy:'never',config:{model_reasoning_effort:'ultra'}}},
    'legacy/close',
  ]);
});

test('a rollback without a receipt never retries through the compatibility runtime',async()=>{
  let attempts=0;
  const runtime={legacyRuntime(){assert.fail('must not create another runtime');},async rpc(){attempts++;throw new BridgeError('timeout','receipt lost',true);}};
  await assert.rejects(revertThread(runtime,{id:'s',historyMode:'legacy'},'chosen',2),/receipt lost/);
  assert.equal(attempts,1);
});
