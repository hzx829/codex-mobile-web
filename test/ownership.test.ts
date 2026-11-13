import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {AppServer} from '../src/connector/app-server.js';
import {BridgeError,type Json} from '../src/shared/types.js';

class Runtime extends EventEmitter {
  requests=new Map<string,Json>();calls:{method:string;params:Json}[]=[];running=false;empty=false;externalOwner=false;unsubscribeError=false;
  async rpc(method:string,params:Json) {
    this.calls.push({method,params});
    if(method==='thread/read')return {thread:{id:'s',model:'native-model',status:{type:this.running?'active':'idle'},turns:this.empty?[]:[{id:'t',status:this.running?'inProgress':'completed',items:[]}]}};
    if(method==='thread/unsubscribe'){if(this.unsubscribeError)throw new BridgeError('runtime_error','failed');return {status:'unsubscribed'};}
    if(method==='thread/resume'){if(this.externalOwner)throw new BridgeError('runtime_error','thread is already open in another application');return {thread:{id:'s'},model:'native-model'};}
    if(method==='turn/start'){this.running=true;return {turn:{id:'next'}};}
    throw Error(method);
  }
  complete(){this.running=false;this.emit('event',{method:'turn/completed',params:{threadId:'s',turn:{id:'t',status:'completed'}}});}
  async unsubscribe(threadId:string){await this.rpc('thread/unsubscribe',{threadId});}
  close(){}
}
class Desktop extends EventEmitter {
  clientId='';states=new Map();owner=false;calls:string[]=[];refreshed:string[]=[];refreshError=false;
  async refreshThread(id:string){if(this.refreshError)throw new Error('desktop offline');this.refreshed.push(id);}
  async follow(){if(!this.owner)throw new BridgeError('no_owner','no owner');return {id:'s',turns:[],requests:[]};}
  async request(method:string){this.calls.push(method);return {result:{turn:{id:'desktop-turn'}}};}
  close(){}
}
function fixture(){
  const runtime=new Runtime(),desktop=new Desktop(),ledger=new Ledger(':memory:'),control=new Control(ledger,runtime as any,desktop as any);
  ledger.claim('s');(control as any).loaded.add('s');
  const settle=()=> (control as any).exclusive('s',async()=>{});
  const send=(source='connector')=>control.handle({id:randomUUID(),action:'turn.send',payload:{threadId:'s',source,generation:control.generation,expectedTurnId:null,text:'next',opId:`${Date.now()}:${randomUUID()}`}});
  return {runtime,desktop,ledger,control,settle,send};
}

test('completed mobile turns release native ownership; reading stays detached and sending resumes once',async()=>{
  const f=fixture();try{
    f.runtime.complete();await f.settle();
    assert.equal(f.runtime.calls.filter(c=>c.method==='thread/unsubscribe').length,1);
    assert.deepEqual(f.desktop.refreshed,['s'],'A persisted mobile thread must be discovered without a desktop search.');
    assert.equal((f.control as any).loaded.has('s'),false);
    const view=await f.control.read('s');assert.equal(view.source,'connector');assert.equal(view.canControl,true);assert.equal(view.model,'native-model');
    assert.equal(f.runtime.calls.some(c=>c.method==='thread/resume'),false,'Reading must not reacquire the desktop lock.');
    assert.equal((await f.send()).state,'accepted');await f.settle();
    assert.equal(f.runtime.calls.filter(c=>c.method==='thread/resume').length,1);
    assert.equal(f.runtime.calls.filter(c=>c.method==='turn/start').length,1);
    assert.deepEqual(f.desktop.refreshed,['s','s'],'A confirmed mobile send also refreshes the desktop while the task runs.');
    assert.equal(f.runtime.calls.filter(c=>c.method==='thread/unsubscribe').length,1,'The new running turn remains owned.');
  }finally{f.control.close();}
});

test('desktop discovery failures do not change a confirmed send or prevent native release',async()=>{
  const f=fixture();try{
    f.desktop.refreshError=true;
    assert.equal((await f.send()).state,'accepted');
    f.runtime.complete();await f.settle();
    assert.equal((f.control as any).loaded.has('s'),false);
    assert.equal(f.runtime.calls.filter(call=>call.method==='turn/start').length,1);
    f.desktop.refreshError=false;
    assert.equal((await f.send()).state,'accepted');
    assert.deepEqual(f.desktop.refreshed,['s']);
  }finally{f.control.close();}
});

test('release never interrupts active turns, approvals, queued sends or unpersisted empty threads',async()=>{
  for(const condition of ['active','approval','queue','empty']) {
    const f=fixture();try{
      if(condition==='active')f.runtime.running=true;
      if(condition==='approval')f.runtime.requests.set('r',{id:'r',params:{threadId:'s'}});
      if(condition==='queue')f.ledger.enqueue(`${Date.now()}:${randomUUID()}`,'s',{source:'connector',text:'next'});
      if(condition==='empty')f.runtime.empty=true;
      (f.control as any).scheduleRelease('s');await f.settle();
      assert.equal(f.runtime.calls.some(c=>c.method==='thread/unsubscribe'),false,condition);
      assert.equal((f.control as any).loaded.has('s'),true,condition);
      assert.deepEqual(f.desktop.refreshed,[],condition);
    }finally{f.control.close();}
  }
});

test('a desktop that acquires the released thread becomes the only write target',async()=>{
  const f=fixture();try{
    f.runtime.complete();await f.settle();f.desktop.owner=true;
    assert.equal((await f.control.read('s')).source,'desktop');
    assert.equal((await f.send()).error.code,'changed','A stale mobile view must refresh its owner before sending.');
    assert.equal((await f.send('desktop')).state,'accepted');
    assert.equal(f.desktop.calls.at(-1),'thread-follower-start-turn');
    assert.equal(f.runtime.calls.some(c=>c.method==='thread/resume'||c.method==='turn/start'),false);
    assert.deepEqual(f.desktop.refreshed,['s'],'Desktop-owned sends already update their own recents.');
  }finally{f.control.close();}
});

test('an external owner not visible over IPC is protected by the native resume lock',async()=>{
  const f=fixture();try{
    f.runtime.complete();await f.settle();f.runtime.externalOwner=true;
    assert.equal((await f.send()).state,'failed');await f.settle();
    assert.equal(f.runtime.calls.some(c=>c.method==='turn/start'),false);
    assert.equal((f.control as any).loaded.has('s'),false);
  }finally{f.control.close();}
});

test('a failed release keeps ownership tracked until native unsubscribe succeeds',async()=>{
  const f=fixture();try{
    f.runtime.unsubscribeError=true;f.runtime.complete();await f.settle();assert.equal((f.control as any).loaded.has('s'),true);
    assert.deepEqual(f.desktop.refreshed,[],'A failed release is not a durable completion.');
    f.runtime.unsubscribeError=false;f.runtime.complete();await f.settle();assert.equal((f.control as any).loaded.has('s'),false);
  }finally{f.control.close();}
});

test('release and a concurrent send share the thread lock',async()=>{
  const f=fixture();try{
    f.runtime.complete();const sent=f.send();await f.settle();assert.equal((await sent).state,'accepted');await f.settle();
    const writes=f.runtime.calls.filter(c=>['thread/unsubscribe','thread/resume','turn/start'].includes(c.method)).map(c=>c.method);
    assert.deepEqual(writes,['thread/unsubscribe','thread/resume','turn/start']);
  }finally{f.control.close();}
});

test('an idle status before turn completion must not unsubscribe the final notification',async()=>{
  const f=fixture();try{
    assert.equal((await f.send()).state,'accepted');f.runtime.running=false;
    f.runtime.emit('event',{method:'thread/status/changed',params:{threadId:'s',status:{type:'idle'}}});await f.settle();
    assert.equal(f.runtime.calls.some(call=>call.method==='thread/unsubscribe'),false);
    f.runtime.complete();await f.settle();assert.equal(f.runtime.calls.filter(call=>call.method==='thread/unsubscribe').length,1);
  }finally{f.control.close();}
});

test('a late native close clears a timed-out release so the next send resumes',async()=>{
  const f=fixture();try{
    f.runtime.unsubscribeError=true;f.runtime.complete();await f.settle();
    assert.equal((f.control as any).loaded.has('s'),true);
    f.runtime.emit('event',{method:'thread/closed',params:{threadId:'s'}});
    assert.equal((f.control as any).loaded.has('s'),false);assert.equal(f.ledger.owns('s'),true);
    assert.equal((await f.send()).state,'accepted');
    assert.equal(f.runtime.calls.filter(call=>call.method==='thread/resume').length,1);
  }finally{f.control.close();}
});

test('a partially named fork still releases the new native thread',async()=>{
  const f=fixture();try{
    const original=f.runtime.rpc.bind(f.runtime);
    f.runtime.rpc=async(method,params)=>{
      if(method==='thread/fork')return {thread:{id:'branch'},model:'native-model'};
      if(method==='thread/name/set')throw new BridgeError('runtime_error','name failed');
      const result=await original(method,params);if(method==='thread/read')result.thread!.id=params.threadId;return result;
    };
    const result=await f.control.handle({id:randomUUID(),action:'session.fork',payload:{threadId:'s',lastTurnId:'t',opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(result.state,'uncertain');assert.match(result.error.message,/branch/);
    assert.equal(f.ledger.owns('branch'),true);assert.equal((f.control as any).loaded.has('branch'),false);
    assert.ok(f.runtime.calls.some(call=>call.method==='thread/unsubscribe'&&call.params.threadId==='branch'));
    assert.ok(f.desktop.refreshed.includes('branch'));
  }finally{f.control.close();}
});

test('native unsubscribe waits for its own close event and removes listeners after timeout',async()=>{
  const runtime=new AppServer('fixture');
  (runtime as any).rpc=async()=>({status:'unsubscribed'});
  let done=false;const pending=runtime.unsubscribe('s').then(()=>{done=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
  runtime.emit('event',{method:'thread/closed',params:{threadId:'other'}});await Promise.resolve();assert.equal(done,false);
  runtime.emit('event',{method:'thread/closed',params:{threadId:'s'}});await pending;assert.equal(runtime.listenerCount('event'),0);
  await assert.rejects(runtime.unsubscribe('slow',5),/仍在释放/);assert.equal(runtime.listenerCount('event'),0);
  (runtime as any).rpc=async()=>({status:'notLoaded'});await runtime.unsubscribe('gone');assert.equal(runtime.listenerCount('event'),0);
});
