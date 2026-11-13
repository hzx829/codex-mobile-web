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
