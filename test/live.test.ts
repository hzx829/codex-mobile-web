import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {RuntimeLive,LiveDiff,diffTurn} from '../src/connector/live.js';
import {normalizeTurn} from '../src/connector/normalize.js';
import {applyPatches} from '../src/connector/desktop.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {applyLiveFrames,keepLiveText,type LiveFrame} from '../web/live.js';
import type {Json,SessionView,TurnView} from '../src/shared/types.js';

const event=(method:string,params:Json)=>({method,params:{threadId:'t',...params}});

test('running turn is rebuilt from notifications, including text that thread/read does not return yet',()=>{
  const live=new RuntimeLive();
  assert.equal(live.apply(event('turn/started',{turn:{id:'u1',items:[],status:'inProgress'}})),false,'A new turn needs a read for running state.');
  assert.equal(live.apply(event('item/started',{turnId:'u1',item:{type:'userMessage',id:'m0',content:[{type:'text',text:'hi'}]}})),true);
  assert.equal(live.apply(event('item/started',{turnId:'u1',item:{type:'reasoning',id:'r1',summary:[],content:[]}})),true);
  live.apply(event('item/reasoning/summaryPartAdded',{turnId:'u1',itemId:'r1',summaryIndex:0}));
  for(const delta of ['**Think','ing**'])live.apply(event('item/reasoning/summaryTextDelta',{turnId:'u1',itemId:'r1',summaryIndex:0,delta}));
  live.apply(event('item/started',{turnId:'u1',item:{type:'agentMessage',id:'a1',text:''}}));
  for(const delta of ['Hello',' world'])assert.equal(live.apply(event('item/agentMessage/delta',{turnId:'u1',itemId:'a1',delta})),true);
  live.apply(event('item/started',{turnId:'u1',item:{type:'commandExecution',id:'c1',command:'ls',status:'inProgress',aggregatedOutput:null}}));
  live.apply(event('item/commandExecution/outputDelta',{turnId:'u1',itemId:'c1',delta:'a.txt\n'}));
  const turn=normalizeTurn(live.turn('t')!);
  assert.equal(turn.status,'inProgress');
  assert.deepEqual(turn.items.map(item=>[item.id,item.role,item.text]),[['m0','user','hi'],['r1','activity','**Thinking**'],['a1','assistant','Hello world'],['c1','activity','ls\ninProgress\na.txt\n']]);
  // Persisted items carry other IDs; a complete live turn replaces them instead of duplicating.
  const merged=live.merge('t',[{id:'u0',status:'completed',items:[]},{id:'u1',status:'inProgress',items:[{id:'item-1',type:'userMessage',content:[{type:'text',text:'hi'}]}]}]);
  assert.equal(merged.length,2);assert.deepEqual(merged[1].items.map((item:Json)=>item.id),['m0','r1','a1','c1']);
  assert.deepEqual(live.merge('t',[{id:'u0',status:'completed',items:[]}]).map(turn=>turn.id),['u0','u1'],'A started turn shows before thread/read has it.');
  live.apply(event('turn/completed',{turn:{id:'u1',status:'completed'}}));
  assert.equal(live.turn('t'),null);assert.equal(live.has('t'),false);
});

test('a turn joined midway combines the persisted items with the ones still running',()=>{
  const live=new RuntimeLive();
  assert.equal(live.apply(event('item/agentMessage/delta',{turnId:'u1',itemId:'a1',delta:'Hel'})),true);
  assert.equal(live.turn('t'),null,'Without a read, the earlier items are unknown.');
  const requestedAt=live.mark();
  live.rememberBase('t',{id:'u1',status:'inProgress',items:[{id:'item-1',type:'userMessage',content:[{type:'text',text:'go'}]}]},requestedAt);
  live.apply(event('item/agentMessage/delta',{turnId:'u1',itemId:'a1',delta:'lo'}));
  assert.deepEqual(normalizeTurn(live.turn('t')!).items.map(item=>item.text),['go','Hello']);
  assert.equal(live.apply(event('item/completed',{turnId:'u1',item:{id:'a1',type:'agentMessage',text:'Hello'}})),false,'Completed items come from the next read.');
  assert.deepEqual(normalizeTurn(live.turn('t')!).items.map(item=>item.text),['go','Hello'],'It stays visible until that read.');
  live.rememberBase('t',{id:'u1',status:'inProgress',items:[{id:'item-1',type:'userMessage',content:[{type:'text',text:'go'}]},{id:'item-2',type:'agentMessage',text:'Hello'}]},live.mark());
  assert.deepEqual(normalizeTurn(live.turn('t')!).items.map(item=>item.id),['item-1','item-2']);
});

const view=(turns:TurnView[]):SessionView=>({id:'t',sessionId:'t',title:'',cwd:'',model:'',provider:'',source:'connector',activeTurnId:turns.at(-1)?.id||null,turns,requests:[],canControl:true,generation:'g'});
const textTurn=(id:string,texts:string[],status='inProgress'):TurnView=>({id,status,canFork:false,items:texts.map((text,index)=>({id:`i${index}`,type:'agentMessage',role:'assistant',text}))});

test('frames carry appended text and new items, and the phone reaches the same turn',()=>{
  const diff=new LiveDiff(),start=textTurn('u',['Hel']);
  diff.prime('t','g',start);
  let phone:SessionView|null=view([{...start,revision:'r1'}]);
  const steps=[textTurn('u',['Hello']),textTurn('u',['Hello',' and']),textTurn('u',['Hello world',' and more']),{...textTurn('u',['Hello world',' and more']),diff:'+x'}];
  for(const next of steps){
    const frame=diff.frame('t','g',next)!;
    assert.ok(frame&&!frame.turn,'Only changes are sent.');
    const result=applyLiveFrames(phone,[frame as LiveFrame]);
    assert.equal(result.resync,false);phone=result.view;
    assert.deepEqual(phone!.turns[0].items,next.items);
  }
  assert.equal(phone!.turns[0].diff,'+x');
  assert.equal(phone!.turns[0].revision,undefined,'An assembled turn is reread rather than trusted.');
  assert.equal(diff.frame('t','g',steps.at(-1)!),null,'Nothing changed, nothing sent.');
  assert.ok(diff.frame('t','g',textTurn('u',['Hello world']))!.turn,'A shorter item list needs the whole turn.');
  assert.ok(diff.frame('t','g',textTurn('v',['new']))!.turn,'A new turn is sent whole.');
  assert.equal(diff.frame('t','g',null),null);
  assert.equal(diffTurn(textTurn('u',['abc']),textTurn('u',['xyz']))!.ops[0].hasOwnProperty('item'),true,'Rewritten text replaces the item.');
});

test('phones skip text they already have and ask for a snapshot when a frame does not line up',()=>{
  const phone=view([textTurn('u',['Hello world'])]);
  const frame=(ops:Json[],extra:Json={}):LiveFrame=>({threadId:'t',generation:'g',turnId:'u',ops,...extra});
  assert.equal(applyLiveFrames(phone,[frame([{i:'i0',o:5,t:' world'}])]).view,phone,'A frame older than the snapshot changes nothing.');
  assert.equal(applyLiveFrames(phone,[frame([{i:'i0',o:6,t:'world!'}])]).view!.turns[0].items[0].text,'Hello world!','An overlapping frame adds only the new part.');
  assert.equal(applyLiveFrames(phone,[frame([{i:'i0',o:20,t:'?'}])]).resync,true,'A gap asks for a snapshot.');
  assert.equal(applyLiveFrames(phone,[frame([{i:'missing',o:0,t:'?'}])]).resync,true);
  assert.equal(applyLiveFrames(phone,[frame([{i:'i0',o:11,t:'!'}],{generation:'old'})]).resync,true);
  assert.equal(applyLiveFrames(phone,[{...frame([]),threadId:'other'}]).view,phone,'Frames for another thread are ignored.');
  const finished=view([textTurn('u',['done'],'completed')]),next=applyLiveFrames(finished,[{threadId:'t',generation:'g',turnId:'v',turn:textTurn('v',['go'])}]);
  assert.deepEqual(next.view!.turns.map(turn=>turn.id),['u','v'],'A new turn shows at once.');assert.equal(next.view!.running,true);assert.equal(next.resync,true);
  // A snapshot read before frames that were already applied keeps the longer text.
  const ahead=view([{...textTurn('u',['Hello world, more']),revision:'x'}]),snapshot=view([{...textTurn('u',['Hello world']),revision:'r'}]);
  const kept=keepLiveText(ahead,snapshot);
  assert.equal(kept.turns[0].items[0].text,'Hello world, more');assert.equal(kept.turns[0].revision,undefined);
  assert.equal(keepLiveText(ahead,view([textTurn('u',['Hello world'],'completed')])).turns[0].items[0].text,'Hello world','A finished turn is final.');
  assert.equal(keepLiveText(ahead,view([textTurn('u',['Different'])])).turns[0].items[0].text,'Different');
});

test('desktop patches copy only the changed path and leave the previous state intact',()=>{
  const state={title:'x',turns:[{id:'a',items:[{id:'1',text:'old'}]},{id:'b',items:[{id:'2',text:'He'}]}],requests:[]};
  const next=applyPatches(state,[{op:'replace',path:['turns',1,'items',0,'text'],value:'Hello'}]);
  assert.equal(state.turns[1].items[0].text,'He');assert.equal(next.turns[1].items[0].text,'Hello');
  assert.equal(next.turns[0],state.turns[0],'Untouched turns keep their identity.');assert.equal(next.requests,state.requests);
  const twice=applyPatches(state,[{op:'add',path:['turns',1,'items',1],value:{id:'3',text:''}},{op:'replace',path:['turns',1,'items',1,'text'],value:'y'}]);
  assert.deepEqual(twice.turns[1].items.map((item:Json)=>item.text),['He','y']);assert.equal(state.turns[1].items.length,1);
  assert.throws(()=>applyPatches(state,[{op:'replace',path:['turns',1,'items',0,'text'],value:'z'},{op:'replace',path:['missing','x'],value:1}]),/missing_patch_baseline/);
  assert.equal(state.turns[1].items[0].text,'He','A failed batch changes nothing.');
});

test('a watched connector thread streams item changes, merges them into reads and still reads for structure',async()=>{
  class Runtime extends EventEmitter{requests=new Map();turns:Json[]=[];async rpc(method:string,params:Json){
    if(method==='thread/start')return {thread:{id:'t',cwd:'/p',turns:[]},model:'m',modelProvider:'openai'};
    if(method==='thread/read')return {thread:{id:params.threadId,cwd:'/p',turns:structuredClone(this.turns)}};
    if(method==='thread/unsubscribe')return {status:'notLoaded'};
    return {};
  }close(){}}
  class Desktop extends EventEmitter{clientId='';states=new Map();async follow(){throw Error('none');}close(){}}
  const runtime=new Runtime(),control=new Control(new Ledger(':memory:'),runtime as any,new Desktop() as any,async()=>[],()=>null);
  const emitted:string[]=[];control.on('change',()=>emitted.push('change'));control.on('stream',()=>emitted.push('stream'));
  try{
    assert.equal((await control.handle({id:randomUUID(),action:'session.create',payload:{cwd:process.cwd(),opId:`${Date.now()}:${randomUUID()}`}})).state,'accepted');
    runtime.turns=[{id:'u0',status:'completed',items:[{id:'item-1',type:'agentMessage',text:'earlier'}]}];
    const fire=(method:string,params:Json)=>runtime.emit('event',{method,params:{threadId:'t',...params}});
    fire('turn/started',{turn:{id:'u1',status:'inProgress',items:[]}});
    fire('item/started',{turnId:'u1',item:{type:'agentMessage',id:'a1',text:''}});
    emitted.length=0;fire('item/agentMessage/delta',{turnId:'u1',itemId:'a1',delta:'Hi'});
    assert.deepEqual(emitted,['change'],'Without a watching phone, old clients keep reading.');
    const first=await control.handle({id:'r',action:'session.read',payload:{threadId:'t',watch:true}});
    assert.deepEqual(first.turns.map((turn:Json)=>turn.id),['u0','u1']);assert.equal(first.turns[1].items[0].text,'Hi','Reads include the running text.');
    assert.equal(control.liveFrame('t'),null,'The read primed the frame base.');
    emitted.length=0;fire('item/agentMessage/delta',{turnId:'u1',itemId:'a1',delta:' there'});
    assert.deepEqual(emitted,['stream']);
    assert.deepEqual(control.liveFrame('t'),{threadId:'t',generation:control.generation,turnId:'u1',ops:[{i:'a1',o:2,t:' there'}]});
    control.livePush=false;emitted.length=0;fire('item/agentMessage/delta',{turnId:'u1',itemId:'a1',delta:'!'});
    assert.deepEqual(emitted,['change'],'A relay without live frames keeps change notices.');
    control.livePush=true;control.liveFrame('t');
    emitted.length=0;fire('turn/diff/updated',{turnId:'u1',diff:'+a'});
    assert.deepEqual(emitted,['change'],'Other notifications still ask for a read.');
    assert.deepEqual(control.liveFrame('t')!.fields,{diff:'+a'});
    fire('turn/completed',{turn:{id:'u1',status:'completed'}});
    assert.equal(control.liveFrame('t'),null);
  }finally{control.close();}
});

test('desktop patches inside the running turn stream; other patches still ask for a read',async()=>{
  class Desktop extends EventEmitter{clientId='d';states=new Map<string,Json>();async follow(id:string){return this.states.get(id)!.state;}close(){}}
  class Runtime extends EventEmitter{requests=new Map();async rpc(){throw Error('unused');}close(){}}
  const desktop=new Desktop(),control=new Control(new Ledger(':memory:'),new Runtime() as any,desktop as any);
  const emitted:string[]=[];control.on('change',()=>emitted.push('change'));control.on('stream',()=>emitted.push('stream'));
  let state:Json={id:'s',cwd:'/p',requests:[],turns:[{turnId:'a',status:'completed',items:[]},{turnId:'b',status:'inProgress',items:[{id:'1',type:'agentMessage',text:'He'}]}]};
  desktop.states.set('s',{state,hostId:'local'});
  const patch=(patches:Json[])=>{const previous=state;state=applyPatches(state,patches);desktop.states.set('s',{state,hostId:'local'});emitted.length=0;desktop.emit('change','s',{patches,previous});return emitted.slice();};
  try{
    assert.deepEqual(patch([{op:'replace',path:['turns',1,'items',0,'text'],value:'Hel'}]),['change'],'Unwatched threads keep the old notice.');
    const read=await control.handle({id:'r',action:'session.read',payload:{threadId:'s',watch:true}});
    assert.equal(read.source,'desktop');
    assert.deepEqual(patch([{op:'replace',path:['turns',1,'items',0,'text'],value:'Hello'}]),['stream']);
    assert.deepEqual(control.liveFrame('s')!.ops,[{i:'1',o:3,t:'lo'}]);
    assert.deepEqual(patch([{op:'add',path:['turns',1,'items',1],value:{id:'2',type:'commandExecution',command:'ls',status:'inProgress'}}]),['stream'],'New items are part of the frame.');
    assert.equal((control.liveFrame('s')!.ops![0] as Json).item.id,'2');
    assert.deepEqual(patch([{op:'replace',path:['updatedAt'],value:2}]),['stream'],'Fields the phone does not show do not cause a read.');
    assert.deepEqual(patch([{op:'add',path:['requests',0],value:{id:9,method:'item/commandExecution/requestApproval',params:{}}}]),['change'],'An approval request needs a read.');
    assert.deepEqual(patch([{op:'replace',path:['turns',0,'items'],value:[{id:'x',type:'agentMessage',text:'edited'}]}]),['change'],'Earlier turns need a read.');
    assert.deepEqual(patch([{op:'replace',path:['turns',1,'status'],value:'completed'}]),['change'],'Finishing the turn needs a read.');
  }finally{control.close();}
});
