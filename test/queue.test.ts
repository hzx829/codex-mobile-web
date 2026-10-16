import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError,type Json} from '../src/shared/types.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const op=()=>`${Date.now()}:${randomUUID()}`;
class Runtime extends EventEmitter {
  requests=new Map();
  async rpc(method:string){assert.equal(method,'model/list');return {data:[{model:'vision',inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'high'}],serviceTiers:[{id:'priority',name:'Fast'}]}]};}
  close(){}
}
class Desktop extends EventEmitter {
  clientId='desktop';states=new Map();active:string|null='original';calls:Json[]=[];failure?:BridgeError;delaySnapshot=false;completed:string[]=[];
  async follow(id:string){return {id,cwd:'C:/project',latestModel:'vision',turns:[...this.completed.map(turnId=>({turnId,status:'completed',items:[]})),...(this.active?[{turnId:this.active,status:'inProgress',items:[]}]:[])],requests:[]};}
  async request(method:string,params:Json){
    this.calls.push({method,params});
    if(method==='thread-follower-start-turn'){
      if(this.failure)throw this.failure;
      const id=`next-${this.starts.length}`;
      if(!this.delaySnapshot)this.active=id;
      return {result:{turn:{id}}};
    }
    return {};
  }
  get starts(){return this.calls.filter(call=>call.method==='thread-follower-start-turn');}
  finish(){if(this.active)this.completed.push(this.active);this.active=null;}
  close(){}
}
const request=(control:Control,payload:Json)=>({id:randomUUID(),action:'turn.send' as const,payload:{threadId:'s',source:'desktop',generation:control.generation,expectedTurnId:'original',text:'queued task',mode:'queue',opId:op(),...payload}});

test('queued messages wait, stay ordered, keep next-turn settings and replay their receipt without resending',async()=>{
  const desktop=new Desktop(),ledger=new Ledger(':memory:'),control=new Control(ledger,new Runtime() as any,desktop as any);
  try{
    const first=request(control,{text:'first',model:'vision',effort:'high',serviceTier:'priority',approvalPolicy:'never'}),second=request(control,{text:'second'});
    const receipt=await control.handle(first);assert.equal(receipt.kind,'queued');assert.equal(receipt.state,'accepted');
    assert.deepEqual(await control.handle(first),receipt);
    await control.handle(second);await control.drainQueue();assert.equal(desktop.starts.length,0);
    assert.deepEqual((await control.read('s')).queuedMessages?.map(message=>message.text),['first','second']);
    desktop.finish();await Promise.all([control.drainQueue(),control.drainQueue()]);
    assert.equal(desktop.starts.length,1);
    assert.equal(desktop.starts[0].params.turnStart.request.input[0].text,'first');
    assert.equal(desktop.starts[0].params.turnStart.request.serviceTier,'priority');
    assert.equal(desktop.starts[0].params.turnStart.request.effort,'high');
    assert.equal(desktop.starts[0].params.turnStart.request.approvalPolicy,'never');
    await control.drainQueue();assert.equal(desktop.starts.length,1);
    desktop.finish();await control.drainQueue();assert.equal(desktop.starts.length,2);
    assert.equal(desktop.starts[1].params.turnStart.request.input[0].text,'second');
    assert.deepEqual((await control.read('s')).queuedMessages,[]);
    assert.equal((await control.handle(first)).kind,'turn_accepted');assert.equal(desktop.starts.length,2);
  }finally{control.close();}
});

test('a completed turn between the click and enqueue is safe, and cancellation removes only the selected entry',async()=>{
  const desktop=new Desktop(),control=new Control(new Ledger(':memory:'),new Runtime() as any,desktop as any);
  try{
    desktop.finish();
    const first=request(control,{}),second=request(control,{text:'remaining'});
    assert.equal((await control.handle(first)).kind,'queued');await control.handle(second);
    const cancel={id:randomUUID(),action:'turn.cancelQueued' as const,payload:{threadId:'s',queuedId:first.payload.opId,opId:op()}};
    const result=await control.handle(cancel);assert.equal(result.kind,'queue_cancelled');assert.deepEqual(await control.handle(cancel),result);
    await control.drainQueue();assert.equal(desktop.starts.length,1);assert.equal(desktop.starts[0].params.turnStart.request.input[0].text,'remaining');
  }finally{control.close();}
});

test('lost dispatch receipts pause the queue and are never retried automatically',async()=>{
  const desktop=new Desktop(),control=new Control(new Ledger(':memory:'),new Runtime() as any,desktop as any);
  try{
    await control.handle(request(control,{}));await control.handle(request(control,{text:'second'}));
    desktop.finish();desktop.failure=new BridgeError('timeout','receipt lost',true);
    await control.drainQueue();await control.drainQueue();
    assert.equal(desktop.starts.length,1);
    const messages=(await control.read('s')).queuedMessages!;
    assert.equal(messages[0].state,'uncertain');assert.equal(messages[1].state,'queued');assert.match(messages[0].error!,/receipt lost/);
  }finally{control.close();}
});

test('the queue validates images and settings before accepting and keeps attachments until dispatch',async()=>{
  const desktop=new Desktop(),control=new Control(new Ledger(':memory:'),new Runtime() as any,desktop as any);
  try{
    for(const payload of [{text:''},{images:['invalid']},{serviceTier:'invented'},{effort:'invented'}])assert.equal((await control.handle(request(control,payload))).state,'failed');
    assert.deepEqual((await control.read('s')).queuedMessages,[]);
    const images=['data:image/png;base64,iVBORw0KGgo='];
    assert.equal((await control.handle(request(control,{text:'',images}))).kind,'queued');
    assert.equal((await control.read('s')).queuedMessages![0].imageCount,1);
    desktop.finish();await control.drainQueue();assert.deepEqual(desktop.starts[0].params.turnStart.request.input,[{type:'image',url:images[0]}]);
  }finally{control.close();}
});

test('queued messages survive restart; an interrupted dispatch stays uncertain',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-queue-')),path=join(dir,'ledger.sqlite');
  let control:Control|undefined;
  try{
    control=new Control(new Ledger(path),new Runtime() as any,new Desktop() as any);
    const queued=request(control,{});await control.handle(queued);control.close();
    const desktop=new Desktop();desktop.finish();control=new Control(new Ledger(path),new Runtime() as any,desktop as any);
    await control.drainQueue();assert.equal(desktop.starts.length,1);assert.equal(control.ledger.read(queued.payload.opId).kind,'turn_accepted');
    const unknown=request(control,{text:'uncertain on restart'});await control.handle(unknown);control.ledger.sending(unknown.payload.opId);control.close();
    control=new Control(new Ledger(path),new Runtime() as any,new Desktop() as any);
    assert.equal((await control.read('s')).queuedMessages![0].state,'uncertain');
    assert.equal(control.ledger.read(unknown.payload.opId).state,'uncertain');
    await control.drainQueue();assert.equal((control.desktop as any).starts.length,0);
  }finally{control?.close();await removeTestTemp(dir);}
});

test('a slow desktop snapshot after dispatch cannot start the next queued message',async()=>{
  const desktop=new Desktop(),control=new Control(new Ledger(':memory:'),new Runtime() as any,desktop as any);
  try{
    await control.handle(request(control,{text:'first'}));await control.handle(request(control,{text:'second'}));
    desktop.finish();desktop.delaySnapshot=true;await control.drainQueue();await control.drainQueue();
    assert.equal(desktop.starts.length,1);assert.equal((await control.read('s')).running,true);
    desktop.completed.push('next-1');await control.drainQueue();assert.equal(desktop.starts.length,2);
  }finally{control.close();}
});
