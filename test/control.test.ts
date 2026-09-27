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

test('thread rename/archive/unarchive use native metadata methods and replay the same receipt',async()=>{
  class Runtime extends EventEmitter{requests=new Map();calls:any[]=[];async rpc(method:string,params:any){this.calls.push({method,params});return {};}close(){}}
  class Desktop extends EventEmitter{clientId='desktop';states=new Map();async follow(){return {id:'s',turns:[],requests:[]};}request(){assert.fail('metadata changes must not start, resume or interrupt a turn');}close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any),changes:string[]=[];
  control.on('change',id=>changes.push(id));
  try{
    for(const [action,method,payload] of [['session.rename','thread/name/set',{name:'新的名称'}],['session.archive','thread/archive',{}],['session.unarchive','thread/unarchive',{}]] as const){
      const request={id:randomUUID(),action,payload:{threadId:'s',...payload,opId:`${Date.now()}:${randomUUID()}`}};
      const first=await control.handle(request);assert.equal(first.state,'accepted');
      assert.deepEqual(await control.handle(request),first);
      assert.deepEqual(runtime.calls.at(-1),{method,params:{threadId:'s',...payload}});
    }
    assert.equal(runtime.calls.length,3);assert.deepEqual(changes,['s','s','s']);
    const invalid=await control.handle({id:'invalid',action:'session.rename',payload:{threadId:'s',name:' ',opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(invalid.state,'failed');assert.equal(runtime.calls.length,3);
  }finally{control.close();}
});

test('archive rejects a running thread even before its active turn is available',async()=>{
  class Runtime extends EventEmitter{requests=new Map();rpc(){assert.fail('must not archive a running thread');}close(){}}
  class Desktop extends EventEmitter{clientId='desktop';states=new Map();turns:any[]=[];async follow(){return {id:'s',status:{type:'active'},turns:this.turns,requests:[]};}close(){}}
  const desktop=new Desktop(),control=new Control(new Ledger(':memory:'),new Runtime() as any,desktop as any);
  try{
    for(const turns of [[],[{turnId:'active',status:'inProgress',items:[]}]]){
      desktop.turns=turns;
      const result=await control.handle({id:randomUUID(),action:'session.archive',payload:{threadId:'s',opId:`${Date.now()}:${randomUUID()}`}});
      assert.equal(result.state,'failed');assert.equal(result.error.code,'active');
    }
  }finally{control.close();}
});

test('image-only turns validate the selected model and reach desktop with the full attachment list',async()=>{
  class Runtime extends EventEmitter{requests=new Map();async rpc(method:string){assert.equal(method,'model/list');return {data:[{model:'vision',inputModalities:['text','image']},{model:'text',inputModalities:['text']}]};}close(){}}
  class Desktop extends EventEmitter{
    clientId='desktop';states=new Map();calls:any[]=[];active=false;
    async follow(){return {id:'s',latestModel:this.active?'vision':'text',turns:this.active?[{turnId:'active',status:'inProgress',items:[]}]:[],requests:[]};}
    async request(method:string,params:any){this.calls.push({method,params});return {result:{turn:{id:'next'}}};}close(){}
  }
  const desktop=new Desktop(),control=new Control(new Ledger(':memory:'),new Runtime() as any,desktop as any);
  const images=['data:image/png;base64,iVBORw0KGgo=','data:image/jpeg;base64,/9j/2Q=='];
  const send=(payload:any)=>control.handle({id:randomUUID(),action:'turn.send',payload:{threadId:'s',source:'desktop',generation:control.generation,expectedTurnId:desktop.active?'active':null,opId:`${Date.now()}:${randomUUID()}`,...payload}});
  try{
    const sent=await send({text:' \n ',images,model:'vision'});assert.equal(sent.state,'accepted');
    assert.deepEqual(desktop.calls.at(-1).params.turnStart.request.input,images.map(url=>({type:'image',url})));
    assert.equal(desktop.calls.at(-1).params.turnStart.request.model,'vision');
    for(const payload of [{text:'',images},{text:'',images:[]},{text:'image',images:[...images,images[0]],model:'vision'},{text:'image',images:['data:image/png;base64,?'],model:'vision'}]){
      const count=desktop.calls.filter(c=>c.method==='thread-follower-start-turn').length;
      assert.equal((await send(payload)).state,'failed');
      assert.equal(desktop.calls.filter(c=>c.method==='thread-follower-start-turn').length,count);
    }
    desktop.active=true;
    assert.equal((await send({images})).state,'accepted');
    assert.equal(desktop.calls.at(-1).method,'thread-follower-steer-turn');
    assert.deepEqual(desktop.calls.at(-1).params.input,images.map(url=>({type:'image',url})));
    assert.equal((await send({images,model:'vision'})).state,'failed');
  }finally{control.close();}
});

test('connector context updates stay with their thread, decrease after compaction, and clear on runtime disconnect',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'cmw-context-'));
  class Runtime extends EventEmitter{
    requests=new Map();count=0;
    async rpc(method:string,params:any){
      if(method==='thread/start')return {thread:{id:`s${++this.count}`,cwd,turns:[]},model:'vision',modelProvider:'openai'};
      if(method==='thread/read')return {thread:{id:params.threadId,cwd,turns:[]}};
      assert.fail(method);
    }close(){}
  }
  class Desktop extends EventEmitter{clientId='';states=new Map();async follow(){throw new BridgeError('no_owner','no desktop owner');}close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any,async()=>[],()=>null);
  const update=(id:string,used:number)=>runtime.emit('event',{method:'thread/tokenUsage/updated',params:{threadId:id,turnId:'t',tokenUsage:{last:{totalTokens:used},total:{totalTokens:9_000_000},modelContextWindow:260000}}});
  try{
    for(let i=0;i<2;i++)assert.equal((await control.handle({id:randomUUID(),action:'session.create',payload:{cwd,opId:`${Date.now()}:${randomUUID()}`}})).state,'accepted');
    assert.equal((await control.read('s1')).contextUsage,null);
    update('s1',104000);update('s2',230000);
    assert.equal((await control.read('s1')).contextUsage?.usedTokens,104000);assert.equal((await control.read('s2')).contextUsage?.usedTokens,230000);
    update('s1',12000);assert.equal((await control.read('s1')).contextUsage?.usedTokens,12000);
    runtime.emit('event',{method:'thread/compacted',params:{threadId:'s1'}});assert.equal((await control.read('s1')).contextUsage,null);
    assert.equal((await control.read('s2')).contextUsage?.usedTokens,230000);
    runtime.emit('offline');assert.equal((await control.read('s2')).contextUsage,null);
  }finally{control.close();await removeTestTemp(cwd);}
});

test('thread status only reads native account limits and does not apply them to another provider',async()=>{
  class Runtime extends EventEmitter{
    requests=new Map();calls:string[]=[];unavailable=false;
    async rpc(method:string){this.calls.push(method);assert.equal(method,'account/rateLimits/read');if(this.unavailable)throw new BridgeError('runtime_error','private native error');return {rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:3,windowDurationMins:10080,resetsAt:1791075340},secondary:null,credits:{private:'not forwarded'}}}};}close(){}
  }
  class Desktop extends EventEmitter{clientId='desktop';states=new Map();async follow(id:string){return {id,modelProvider:id==='custom'?'custom':'openai',turns:[]};}close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any);
  const read=(threadId:string)=>control.handle({id:randomUUID(),action:'session.status',payload:{threadId}});
  try{
    const result=await read('native');assert.equal(result.threadId,'native');assert.equal(result.limits[0].windowMinutes,10080);assert.equal(result.limits[0].usedPercent,3);
    assert.ok(!JSON.stringify(result).includes('private'));
    const custom=await read('custom');assert.deepEqual(custom.limits,[]);assert.ok(custom.limitsNotice.includes('提供商'));assert.equal(runtime.calls.length,1);
    runtime.unavailable=true;const missing=await read('native');assert.deepEqual(missing.limits,[]);assert.ok(missing.limitsNotice.includes('暂未提供'));assert.ok(!JSON.stringify(missing).includes('private'));
    assert.deepEqual(runtime.calls,['account/rateLimits/read','account/rateLimits/read']);
  }finally{control.close();}
});
