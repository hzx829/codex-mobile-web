import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {normalizeSession,turnPage} from '../src/connector/normalize.js';
import {refreshHistory,prependHistory} from '../web/thread-history.js';
import {BridgeError,type Json,type SessionView,type TurnCursor} from '../src/shared/types.js';

const turns=(start:number,end:number):Json[]=>Array.from({length:end-start},(_,i)=>({id:`t${start+i}`,status:'completed',items:[{id:`m${start+i}`,type:'agentMessage',text:`message ${start+i}`}]}));
const view=(start:number,end:number):SessionView=>({...normalizeSession({id:'s',turns:turns(start,end)},'desktop',[],end-start),generation:'g',hasMore:start>0,nextCursor:start>0?{before:`t${start}`}:null});

test('history pages cross 100 turns without gaps or duplicates when a new turn arrives',async()=>{
  const all=turns(0,145);
  class Runtime extends EventEmitter{requests=new Map();rpc(){assert.fail('Complete desktop snapshots need no runtime reads');}close(){}}
  class Desktop extends EventEmitter{states=new Map();async follow(){return {id:'s',turns:all};}close(){}}
  const control=new Control(new Ledger(':memory:'),new Runtime() as any,new Desktop() as any);
  try{
    const first=await control.handle({id:'first',action:'session.read',payload:{threadId:'s',limit:20}});
    assert.deepEqual(first.turns.map((turn:Json)=>turn.id),turns(125,145).map(turn=>turn.id));
    all.push(...turns(145,146));
    let cursor:TurnCursor|null=first.nextCursor;const loaded=[...first.turns];
    while(cursor){
      const page=await control.handle({id:'older',action:'session.read',payload:{threadId:'s',limit:20,cursor}});
      assert.ok(page.turns.length<=20);loaded.unshift(...page.turns);cursor=page.nextCursor;
    }
    assert.deepEqual(loaded.map(turn=>turn.id),turns(0,145).map(turn=>turn.id));
    await assert.rejects(control.read('s',20,{before:'deleted'}),/历史位置已变化/);
  }finally{control.close();}
});

test('partial desktop history combines bounded persisted pages with live items and a new turn',async()=>{
  const persisted=turns(0,35),reads:{limit:number;before?:string}[]=[];
  const live={...persisted[34],turnId:'t34',itemsPagination:{hasLoadedOldest:false},items:[{id:'live',type:'agentMessage',text:'streamed answer'}]};
  const active={id:'t35',turnId:'t35',status:'inProgress',items:[]};
  class Runtime extends EventEmitter{requests=new Map();rpc(){assert.fail('The local history index supplies pages');}close(){}}
  class Desktop extends EventEmitter{states=new Map();async follow(){return {id:'s',threadRuntimeStatus:{type:'active'},turnHistory:{kind:'canonical',history:{isComplete:false,entitiesByKey:{old:persisted[0],live,active},islands:[{entries:[{value:'old'}]},{entries:[{value:'live'},{value:'active'}]}]}}};}close(){}}
  const history=(_id:string,limit:number,_home?:string,before?:string)=>{reads.push({limit,before});return turnPage(persisted,limit,before);};
  const control=new Control(new Ledger(':memory:'),new Runtime() as any,new Desktop() as any,async()=>[],history);
  try{
    const first=await control.read('s');
    assert.equal(first.source,'desktop');assert.equal(first.canControl,true);assert.equal(first.activeTurnId,'t35');
    assert.deepEqual(first.turns.map(turn=>turn.id),turns(16,36).map(turn=>turn.id));
    assert.deepEqual(first.turns.find(turn=>turn.id==='t34')?.items.map(item=>item.text),['message 34','streamed answer']);
    const older=await control.read('s',20,first.nextCursor!);
    assert.deepEqual(older.turns.map(turn=>turn.id),turns(0,16).map(turn=>turn.id));assert.equal(older.nextCursor,null);
    assert.deepEqual(reads,[{limit:20,before:undefined},{limit:20,before:'t16'}]);
  }finally{control.close();}
});

test('native pagination can continue from a desktop turn anchor without a native cursor',async()=>{
  class Runtime extends EventEmitter{
    requests=new Map();pages:(string|undefined)[]=[];
    async rpc(method:string,params:Json){
      if(method==='thread/read'&&params.includeTurns)throw new BridgeError('runtime_error','paginated threads do not support thread/read(includeTurns=true)');
      if(method==='thread/read')return {thread:{id:'s'}};
      assert.equal(method,'thread/turns/list');this.pages.push(params.cursor);
      return params.cursor?{data:turns(0,20).reverse(),nextCursor:null}:{data:turns(20,40).reverse(),nextCursor:'older'};
    }
    close(){}
  }
  class Desktop extends EventEmitter{async follow(){throw Error('no owner');}close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any,async()=>[],()=>null);
  try{
    const older=await control.read('s',20,{before:'t20'});
    assert.deepEqual(older.turns.map(turn=>turn.id),turns(0,20).map(turn=>turn.id));assert.equal(older.nextCursor,null);
    assert.deepEqual(runtime.pages,[undefined,'older']);
  }finally{control.close();}
});

test('a detached reader follows an external turn without mistaking it for a stop',async()=>{
  const tail={...turns(2,3)[0],status:'interrupted',completedAt:null as number|null};
  const reads:string[]=[];
  let hasWriter=true;
  class Runtime extends EventEmitter{
    requests=new Map();
    async rpc(method:string){
      assert.equal(method,'thread/read');
      return {thread:{id:'s',status:{type:'notLoaded'},turns:[...turns(0,2),tail]}};
    }
    close(){}
  }
  class Desktop extends EventEmitter{async follow(){throw Error('no owner');}close(){}}
  const ledger=new Ledger(':memory:');ledger.claim('s');
  const control=new Control(ledger,new Runtime() as any,new Desktop() as any,undefined,undefined,undefined,async (threadId,turnId)=>{
    assert.equal(threadId,'s');assert.ok(turnId);reads.push(turnId);return hasWriter;
  });
  try{
    const active=await control.read('s',1);
    assert.equal(active.source,'history');assert.equal(active.canControl,false);
    assert.equal(active.running,true);assert.equal(active.activeTurnId,'t2');
    assert.equal(active.turns[0].status,'inProgress');assert.equal(active.turns[0].canFork,false);
    assert.deepEqual(active.turns[0].items.map(item=>item.text),['message 2']);
    const resume=await control.handle({id:'resume',action:'session.resume',payload:{threadId:'s',confirmIdle:true,opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(resume.error?.code,'active');

    const older=await control.read('s',1,active.nextCursor!);
    assert.deepEqual(older.turns.map(turn=>turn.id),['t1']);
    assert.deepEqual(reads,['t2','t2']);

    hasWriter=false;
    const stopped=await control.read('s');
    assert.equal(stopped.running,false);assert.equal(stopped.turns.at(-1)?.status,'interrupted');

    hasWriter=true;tail.completedAt=1;
    const explicitlyStopped=await control.read('s');
    assert.equal(explicitlyStopped.running,false);assert.equal(explicitlyStopped.turns.at(-1)?.status,'interrupted');

    tail.status='completed';
    const completed=await control.read('s');
    assert.equal(completed.source,'connector');assert.equal(completed.canControl,true);
    assert.equal(completed.running,false);assert.equal(completed.turns.at(-1)?.status,'completed');
    assert.deepEqual(reads,['t2','t2','t2']);
  }finally{control.close();}
});

test('a new turn can be read and listed before the native history is written',async()=>{
  const desktopState={turns:[{id:'desktop-turn',status:'inProgress'}]};
  class Runtime extends EventEmitter{
    requests=new Map();reads=0;
    async rpc(method:string){
      if(method==='thread/start')return {thread:{id:'fresh',status:{type:'idle'},turns:[]}};
      if(method==='turn/start'){
        const turn={id:'first'};this.emit('event',{method:'turn/started',params:{threadId:'fresh',turn}});return {turn};
      }
      assert.equal(method,'thread/read');this.reads++;
      throw new BridgeError('runtime_error','thread fresh is not materialized yet');
    }
    close(){}
  }
  class Desktop extends EventEmitter{states=new Map([['desktop',{state:desktopState}]]);async refreshThread(){}close(){}}
  const runtime=new Runtime(),list=()=>({data:['fresh','desktop','external','idle'].map(id=>({id,title:id,cwd:'',model:'',provider:'',updatedAt:0})),nextCursor:null});
  const control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any,undefined,undefined,list,async(id)=>id==='external');
  try{
    const created=await control.handle({id:'create',action:'session.create',payload:{cwd:process.cwd(),opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(created.state,'accepted');
    assert.equal((await control.read('fresh')).running,false);assert.equal(runtime.reads,1);
    const sent=await control.handle({id:'send',action:'turn.send',payload:{threadId:'fresh',source:'connector',generation:created.generation,expectedTurnId:null,text:'first',opId:`${Date.now()}:${randomUUID()}`}});
    assert.equal(sent.state,'accepted');assert.equal(runtime.reads,2);
    assert.equal((await control.read('fresh')).activeTurnId,'first');assert.equal(runtime.reads,3);

    const active=async()=>{
      const page=await control.handle({id:'list',action:'sessions.list',payload:{}});
      return page.data.filter((thread:any)=>thread.status?.type==='active').map((thread:any)=>thread.id);
    };
    assert.deepEqual(await active(),['fresh','desktop','external']);
    runtime.emit('event',{method:'thread/closed',params:{threadId:'fresh'}});
    desktopState.turns[0].status='completed';
    assert.deepEqual(await active(),['external']);
  }finally{control.close();}
});

test('fork and edit still reach a selected turn older than 100 rounds',async()=>{
  class Runtime extends EventEmitter{
    requests=new Map();all=turns(0,145);rollback=0;
    constructor(){super();this.all[1].items=[{id:'input',type:'userMessage',content:[{type:'text',text:'original'}]}];}
    async rpc(method:string,params:Json){
      if(method==='thread/read')return {thread:{id:'s',historyMode:'legacy',turns:this.all}};
      if(method==='thread/fork'){assert.equal(params.lastTurnId,'t1');return {thread:{id:'branch'}};}
      if(method==='thread/name/set')return {};
      if(method==='thread/rollback'){this.rollback=params.numTurns;this.all=this.all.slice(0,-params.numTurns);return {thread:{id:'s',turns:this.all}};}
      if(method==='turn/start')return {turn:{id:'new'}};
      assert.fail(method);
    }
    close(){}
  }
  class Desktop extends EventEmitter{states=new Map();close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any);
  const op=()=>`${Date.now()}:${randomUUID()}`;
  try{
    (control as any).loaded.add('s');
    const forked=await control.handle({id:'fork',action:'session.fork',payload:{threadId:'s',lastTurnId:'t1',opId:op()}});
    assert.equal(forked.state,'accepted');
    const edited=await control.handle({id:'edit',action:'turn.edit',payload:{threadId:'s',source:'connector',generation:control.generation,expectedTurnId:null,turnId:'t1',itemId:'input',text:'revised',opId:op()}});
    assert.equal(edited.state,'accepted');assert.equal(runtime.rollback,144);assert.deepEqual(runtime.all.map(turn=>turn.id),['t0']);
  }finally{control.close();}
});

test('refresh keeps loaded history, updates the live tail, and removes reverted turns',()=>{
  const loaded=view(20,60),next=view(42,62);next.turns.at(-1)!.items[0].text='live';
  const refreshed=refreshHistory(loaded,next);
  assert.deepEqual(refreshed.turns.map(turn=>turn.id),turns(20,62).map(turn=>turn.id));
  assert.equal(refreshed.turns.at(-1)!.items[0].text,'live');assert.deepEqual(refreshed.nextCursor,{before:'t20'});
  const reverted=refreshHistory(refreshed,view(30,50));
  assert.deepEqual(reverted.turns.map(turn=>turn.id),turns(20,50).map(turn=>turn.id));
  assert.deepEqual(refreshHistory(reverted,view(0,10)),view(0,10));
  assert.deepEqual(refreshHistory(loaded,view(80,100)),view(80,100),'A gap resets the window so missing turns remain reachable.');
});

test('live refresh preserves unchanged turns while publishing streamed text and session metadata',()=>{
  const current=view(0,25);current.turns.at(-1)!.status='inProgress';
  const repeated=refreshHistory(current,structuredClone(current));
  assert.equal(repeated.turns,current.turns,'An unchanged full snapshot keeps the rendered history stable.');
  const next=view(5,25);next.running=true;next.title='renamed';next.turns.at(-1)!.status='inProgress';next.turns.at(-1)!.items[0].text+=' continued';
  const refreshed=refreshHistory(current,next);
  assert.equal(refreshed.title,'renamed');assert.equal(refreshed.running,true);
  assert.equal(refreshed.turns.length,25);assert.equal(refreshed.hasMore,false);
  assert.ok(refreshed.turns.slice(0,-1).every((turn,index)=>turn===current.turns[index]));
  assert.notEqual(refreshed.turns.at(-1),current.turns.at(-1));assert.equal(refreshed.turns.at(-1)!.items[0].text,'message 24 continued');
  const completed=structuredClone(refreshed);completed.turns.at(-1)!.status='completed';completed.running=false;
  const finished=refreshHistory(refreshed,completed);
  assert.notEqual(finished.turns.at(-1),refreshed.turns.at(-1));assert.equal(finished.turns.at(-1)!.status,'completed');
});

test('history refresh publishes attachment updates and never reuses turns across owners',()=>{
  const current=view(0,2);current.turns[0].items[0].images=['old.png'];current.turns[0].items[0].files=['old.txt'];
  const next=structuredClone(current);next.turns[0].items[0].images=['new.png'];next.turns[0].items[0].files=['new.txt'];
  const refreshed=refreshHistory(current,next);
  assert.equal(refreshed.turns[0],next.turns[0]);assert.equal(refreshed.turns[1],current.turns[1]);
  for(const changed of [{...structuredClone(current),generation:'new'},{...structuredClone(current),source:'connector' as const}]){
    assert.equal(refreshHistory(current,changed),changed);
    assert.notEqual(changed.turns[0],current.turns[0]);
  }
});

test('an older page preserves concurrent live updates and ignores stale or duplicate responses',()=>{
  const current=view(20,42);current.title='new title';current.running=true;
  const older=view(0,20),cursor={before:'t20'};
  const merged=prependHistory(current,older,cursor)!;
  assert.deepEqual(merged.turns.map(turn=>turn.id),turns(0,42).map(turn=>turn.id));
  assert.equal(merged.title,'new title');assert.equal(merged.running,true);assert.equal(merged.hasMore,false);
  assert.equal(prependHistory(merged,older,cursor),merged);
  assert.equal(prependHistory({...current,id:'other'},older,cursor)?.id,'other');
  assert.equal(prependHistory(current,{...older,generation:'stale'},cursor),current);
  assert.equal(prependHistory(current,older,{before:'removed'}),current);
  assert.equal(prependHistory(current,view(20,40),cursor)?.hasMore,false,'A page that makes no progress must not trigger a fetch loop.');
});
