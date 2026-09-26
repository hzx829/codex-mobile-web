import {removeTestTemp} from '../scripts/test-temp.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError} from '../src/shared/types.js';

test('desktop writes use the original owner, expected turn and correct approval method',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'cmw-control-'));const ledger=new Ledger(':memory:');
  class Runtime extends EventEmitter{calls:any[]=[];requests=new Map();rpc(method:string){this.calls.push(method);throw Error('must not create a shadow runtime');}close(){}}
  class Desktop extends EventEmitter{clientId='desktop';states=new Map([['s',{hostId:'local'}]]);calls:any[]=[];state={id:'s',cwd,turns:[{turnId:'active',status:'inProgress',items:[]}],requests:[{id:123,method:'item/permissions/requestApproval',params:{permissions:{network:{enabled:true}}}}]};async follow(){return this.state;}async request(method:string,params:any){this.calls.push({method,params});return {};}close(){}}
  const runtime=new Runtime(),desktop=new Desktop(),control=new Control(ledger,runtime as any,desktop as any);
  try{
    const base={threadId:'s',source:'desktop',generation:control.generation,expectedTurnId:'active'};
    const request=(action:any,payload:any)=>control.handle({id:randomUUID(),action,payload:{...base,...payload,opId:`${Date.now()}:${randomUUID()}`}});
    const changed=await request('turn.send',{expectedTurnId:'previous',text:'hello'});assert.equal(changed.state,'failed');assert.equal(changed.error.code,'changed');
    const send=await request('turn.send',{text:'hello'});assert.equal(send.state,'accepted');assert.equal(desktop.calls.at(-1).method,'thread-follower-steer-turn');assert.equal(desktop.calls.at(-1).params.expectedTurnId,'active');
    assert.deepEqual(desktop.calls.at(-1).params.input,[{type:'text',text:'hello',text_elements:[]}]);
    await request('turn.stop',{});assert.equal(desktop.calls.at(-1).params.mode,'user-stop');
    await request('request.respond',{requestId:'123',response:{allow:true,scope:'turn'}});assert.equal(desktop.calls.at(-1).method,'thread-follower-permissions-request-approval-response');assert.equal(desktop.calls.at(-1).params.requestId,123);
    assert.equal(runtime.calls.length,0);
  }finally{control.close();await removeTestTemp(cwd);}
});

test('desktop turn start sends renderable text without relying on app-server defaults',async()=>{
  const ledger=new Ledger(':memory:');
  class Runtime extends EventEmitter{requests=new Map();rpc(){throw Error('must not create a shadow runtime');}close(){}}
  class Desktop extends EventEmitter{
    clientId='desktop';states=new Map([['s',{hostId:'local'}]]);calls:any[]=[];
    async follow(){return {id:'s',turns:[],requests:[]};}
    async request(method:string,params:any){
      this.calls.push({method,params});
      if(method==='thread-follower-start-turn'){
        // Desktop 26.908 reads text_elements.length from the original IPC input.
        // App-server accepts omitted text_elements but only defaults its own copy.
        for(const item of params.turnStart.request.input)if(item.type==='text')assert.equal(item.text_elements.length,0);
        return {result:{turn:{id:'next'}}};
      }
      return {};
    }
    close(){}
  }
  const desktop=new Desktop(),control=new Control(ledger,new Runtime() as any,desktop as any);
  try{
    const opId=`${Date.now()}:${randomUUID()}`;
    const result=await control.handle({id:randomUUID(),action:'turn.send',payload:{threadId:'s',source:'desktop',generation:control.generation,expectedTurnId:null,text:'手机继续这段对话',opId}});
    assert.equal(result.state,'accepted');assert.equal(result.turnId,'next');
    const start=desktop.calls.at(-1);
    assert.equal(start.method,'thread-follower-start-turn');
    assert.deepEqual(start.params.turnStart,{request:{threadId:'s',input:[{type:'text',text:'手机继续这段对话',text_elements:[]}],clientUserMessageId:opId},context:{inheritThreadSettings:true}});
  }finally{control.close();}
});

test('approval policy is validated and forwarded to native turn start',async()=>{
  const ledger=new Ledger(':memory:');
  class Runtime extends EventEmitter{requests=new Map();rpc(){throw Error('desktop turn must stay on desktop');}close(){}}
  class Desktop extends EventEmitter{
    clientId='desktop';states=new Map([['s',{hostId:'local'}]]);calls:any[]=[];
    async follow(){return {id:'s',sessionId:'root',turns:[],requests:[]};}
    async request(method:string,params:any){this.calls.push({method,params});return {result:{turn:{id:'next'}}};}
    close(){}
  }
  const desktop=new Desktop(),control=new Control(ledger,new Runtime() as any,desktop as any);
  const base={threadId:'s',source:'desktop',generation:control.generation,expectedTurnId:null,text:'next'};
  try{
    assert.equal((await control.read('s')).sessionId,'root');
    const invalid=await control.handle({id:'invalid',action:'turn.send',payload:{...base,approvalPolicy:'always',opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(invalid.state,'failed');assert.equal(invalid.error.code,'invalid');
    assert.equal(desktop.calls.some(c=>c.method==='thread-follower-start-turn'),false);
    const sent=await control.handle({id:'valid',action:'turn.send',payload:{...base,model:'model-a',approvalPolicy:'on-request',opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(sent.state,'accepted');
    assert.equal(desktop.calls.at(-1).params.turnStart.request.model,'model-a');
    assert.equal(desktop.calls.at(-1).params.turnStart.request.approvalPolicy,'on-request');
  }finally{control.close();}
});

test('a newly created paginated thread can send its first turn without listing history',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'cmw-new-thread-'));
  class Runtime extends EventEmitter {
    requests=new Map();calls:string[]=[];startParams:any;turnParams:any;
    async rpc(method:string,params:any){
      this.calls.push(method);
      if(method==='thread/start'){this.startParams=params;return {thread:{id:'new',cwd,historyMode:'paginated',status:{type:'idle'}},model:'test-model',modelProvider:'openai'};}
      if(method==='thread/read'&&params.includeTurns)throw new BridgeError('runtime_error','list_turns is not supported yet');
      if(method==='thread/read')return {thread:{id:'new',cwd,historyMode:'paginated',status:{type:'idle'},turns:[]}};
      if(method==='turn/start'){this.turnParams=params;return {turn:{id:'first'}};}
      throw Error(method);
    }
    close(){}
  }
  class Desktop extends EventEmitter {clientId='';states=new Map();close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any,async()=>[],()=>null);
  try {
    const created=await control.handle({id:'create',action:'session.create',payload:{cwd,approvalPolicy:'never',opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(created.state,'accepted');
    assert.equal(runtime.startParams.historyMode,'legacy');
    assert.equal(runtime.startParams.approvalPolicy,'never');
    const session=await control.read(created.threadId);
    assert.equal(session.canControl,true);assert.equal(session.turns.length,0);
    const sent=await control.handle({id:'send',action:'turn.send',payload:{threadId:created.threadId,source:session.source,generation:session.generation,expectedTurnId:null,text:'first message',approvalPolicy:'on-request',opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(sent.state,'accepted');assert.equal(sent.turnId,'first');
    assert.equal(runtime.turnParams.approvalPolicy,'on-request');
    assert.equal(runtime.calls.includes('thread/turns/list'),false);
  }finally{control.close();await removeTestTemp(cwd);}
});
