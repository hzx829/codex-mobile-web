import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readModels,reasoningEffort} from '../src/connector/models.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';

test('model options come from the same runtime that executes turns',async()=>{
  const calls:string[]=[];
  const runtime={async rpc(method:string){calls.push(method);return {data:['gpt-6-astra']};}};
  assert.deepEqual(await readModels(runtime),{data:['gpt-6-astra']});
  assert.deepEqual(calls,['model/list']);
});

test('reasoning effort follows the runtime catalog, including ultra and future values',async()=>{
  const runtime={async rpc(method:string){assert.equal(method,'model/list');return {data:[{model:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'ultra'},{reasoningEffort:'future'}]}]};}};
  assert.equal(await reasoningEffort(runtime,'ultra','gpt-6-astra'),'ultra');
  assert.equal(await reasoningEffort(runtime,'future','gpt-6-astra'),'future');
  await assert.rejects(reasoningEffort(runtime,'max','gpt-6-astra'),/不支持/);
  await assert.rejects(reasoningEffort(runtime,'','gpt-6-astra'),/推理档位/);
  // Custom provider models can be absent from the OpenAI picker; their runtime validates effort.
  assert.equal(await reasoningEffort(runtime,'high','custom-model'),'high');
});

test('selecting Astra ultra reaches the desktop while an unsupported model effort sends no turn',async()=>{
  class Runtime extends EventEmitter{
    requests=new Map();
    async rpc(method:string){assert.equal(method,'model/list');return {data:[{model:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]},{model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'max'}]}]};}
    close(){}
  }
  class Desktop extends EventEmitter{
    clientId='desktop';states=new Map();starts:any[]=[];
    async follow(){return {id:'s',latestModel:'gpt-6.1-sol',turns:[]};}
    async request(method:string,params:any){if(method==='thread-follower-start-turn')this.starts.push(params.turnStart.request);return {result:{turn:{id:'next'}}};}
    close(){}
  }
  const desktop=new Desktop(),control=new Control(new Ledger(':memory:'),new Runtime() as any,desktop as any);
  const send=(model:string)=>control.handle({id:randomUUID(),action:'turn.send',payload:{threadId:'s',source:'desktop',generation:control.generation,expectedTurnId:null,text:'task',model,effort:'ultra',opId:`${Date.now()}:${randomUUID()}`}});
  try{
    assert.equal((await send('gpt-6-astra')).state,'accepted');
    assert.equal(desktop.starts[0].model,'gpt-6-astra');assert.equal(desktop.starts[0].effort,'ultra');
    const invalid=await send('gpt-6-luna');assert.equal(invalid.state,'failed');assert.equal(invalid.error.code,'invalid');assert.equal(desktop.starts.length,1);
  }finally{control.close();}
});
