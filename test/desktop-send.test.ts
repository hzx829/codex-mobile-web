import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError,type Json} from '../src/shared/types.js';

function fixture() {
  class Runtime extends EventEmitter {
    requests=new Map();
    rpc(){assert.fail('desktop sends must not start a second runtime');}
    close(){}
  }
  class Desktop extends EventEmitter {
    clientId='desktop';state:Json={id:'s',turns:[],requests:[]};
    states=new Map([['s',{hostId:'local',state:this.state}]]);starts=0;
    failure=new BridgeError('timeout','thread-follower-start-turn-timeout',true);
    onStart:(request:Json)=>void=()=>{};
    async follow(){return this.state;}
    async request(method:string,params:Json){
      if(method==='thread-follower-start-turn'){
        this.starts++;this.onStart(params.turnStart.request);throw this.failure;
      }
      assert.equal(method,'thread-owner-discovery');return {};
    }
    close(){}
  }
  const desktop=new Desktop(),ledger=new Ledger(':memory:'),control=new Control(ledger,new Runtime() as any,desktop as any);
  const request={id:randomUUID(),action:'turn.send' as const,payload:{threadId:'s',source:'desktop',generation:control.generation,expectedTurnId:null,text:'continue',opId:`${Date.now()}:${randomUUID()}`}};
  return {desktop,ledger,control,request};
}

test('desktop timeout followed by the matching live turn acknowledges the original send once',async()=>{
  const {desktop,ledger,control,request}=fixture();let timer:NodeJS.Timeout|undefined;
  try {
    desktop.onStart=input=>{
      // The optimistic input has no native turn ID and is not an acknowledgement.
      desktop.state.turns=[{params:input,status:'inProgress',items:[]}];
      timer=setTimeout(()=>{
        desktop.state.turns[0].turnId='native-turn';desktop.emit('change','s');
      },20);
    };
    const result=await control.handle(request);
    assert.deepEqual(result,{state:'accepted',threadId:'s',turnId:'native-turn',kind:'turn_accepted'});
    assert.deepEqual(ledger.read(request.payload.opId),result);
    assert.deepEqual(await control.handle(request),result);assert.equal(desktop.starts,1);
    assert.equal(desktop.listenerCount('change'),1);assert.equal(desktop.listenerCount('offline'),1);
  }finally{clearTimeout(timer);control.close();}
});

test('a completed canonical turn with the same user client ID confirms a lost desktop response',async()=>{
  const {desktop,control,request}=fixture();
  try {
    desktop.onStart=input=>{
      desktop.state.turnHistory={kind:'canonical',history:{islands:[{entries:[{value:'t'}]}],entitiesByKey:{t:{turnId:'completed-turn',status:'completed',items:[{id:'user',type:'userMessage',clientId:input.clientUserMessageId,content:input.input}]}}}};
    };
    const result=await control.handle(request);
    assert.equal(result.state,'accepted');assert.equal(result.turnId,'completed-turn');
    assert.equal((await control.read('s')).running,false);assert.equal(desktop.starts,1);
  }finally{control.close();}
});

test('an unrelated active turn cannot turn a timeout into success and replay never resends',async()=>{
  const {desktop,ledger,control,request}=fixture();
  try {
    desktop.onStart=input=>{desktop.state.turns=[{turnId:'other-turn',status:'inProgress',params:{...input,clientUserMessageId:'another-message'},items:[]}];};
    const result=await control.handle(request);
    assert.equal(result.state,'uncertain');assert.equal(result.error.code,'timeout');
    assert.deepEqual(ledger.read(request.payload.opId),result);
    assert.deepEqual(await control.handle(request),result);assert.equal(desktop.starts,1);
    assert.equal(desktop.listenerCount('change'),1);assert.equal(desktop.listenerCount('offline'),1);
  }finally{control.close();}
});

test('a definite desktop rejection stays failed even if a matching snapshot exists',async()=>{
  const {desktop,control,request}=fixture();
  try {
    desktop.failure=new BridgeError('desktop_error','invalid-input');
    desktop.onStart=input=>{desktop.state.turns=[{turnId:'native-turn',params:input,items:[]}];};
    const result=await control.handle(request);
    assert.equal(result.state,'failed');assert.equal(result.error.code,'desktop_error');assert.equal(desktop.starts,1);
  }finally{control.close();}
});
