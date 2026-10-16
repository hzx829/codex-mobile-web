import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readModels,reasoningEffort} from '../src/connector/models.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {fastTier} from '../src/shared/models.js';

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
    async follow(){return {id:'s',latestModel:'gpt-6.1-sol',turns:this.starts.length?[{turnId:'next',status:'completed',items:[]}]:[]};}
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

test('fast mode follows native service tier IDs and explicitly clears the inherited tier when switched off',async()=>{
  assert.equal(fastTier({serviceTiers:[{id:'priority',name:'Fast'}]}),'priority');
  assert.equal(fastTier({additionalSpeedTiers:['fast']}),'fast');assert.equal(fastTier({}),undefined);
  class Runtime extends EventEmitter {
    requests=new Map();calls:any[]=[];
    async rpc(method:string,params:any){
      this.calls.push({method,params});
      if(method==='thread/read')return {thread:{id:'s',model:'vision',turns:this.calls.some(call=>call.method==='turn/start')?[{id:'next',status:'completed',items:[]}]:[]}};
      if(method==='model/list')return {data:[{model:'vision',serviceTiers:[{id:'priority',name:'Fast'}]}]};
      if(method==='turn/start')return {turn:{id:'next'}};
      assert.fail(method);
    }close(){}
  }
  class Desktop extends EventEmitter{clientId='';states=new Map();close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any);
  (control as any).loaded.add('s');
  const send=(serviceTier:unknown)=>control.handle({id:randomUUID(),action:'turn.send',payload:{threadId:'s',source:'connector',generation:control.generation,expectedTurnId:null,text:'task',serviceTier,opId:`${Date.now()}:${randomUUID()}`}});
  try{
    assert.equal((await send('priority')).state,'accepted');assert.equal(runtime.calls.at(-1).params.serviceTier,'priority');
    assert.equal((await control.read('s')).serviceTier,'priority');
    assert.equal((await send(null)).state,'accepted');assert.equal(runtime.calls.at(-1).params.serviceTier,null);
    assert.equal((await control.read('s')).serviceTier,null);
    assert.equal((await send('invented')).state,'failed');assert.equal(runtime.calls.filter(call=>call.method==='turn/start').length,2);
  }finally{control.close();}
});
