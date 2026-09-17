import {removeTestTemp} from './test-temp.js';
// An actual Codex app-server talks to a local Responses fixture. No model account or existing session is used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {AppServer,resolveCodex} from '../src/connector/app-server.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import type {Json} from '../src/shared/types.js';
const dir=await mkdtemp(join(tmpdir(),'cmw-native-')),home=join(dir,'codex'),project=join(dir,'project');await mkdir(home);await mkdir(project);
const fixtureKey=randomUUID();let receivedModel='',receivedAuth=false,hang=false,onRequest:(()=>void)|undefined;
const api=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);let body:any={};try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{}
  receivedModel=body.model||'';receivedAuth=req.headers.authorization===`Bearer ${fixtureKey}`;
  const id=`resp_${randomUUID()}`,item={id:`msg_${randomUUID()}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'FIXTURE_OK',annotations:[]}]};
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  const emit=(event:Json)=>res.write(`data: ${JSON.stringify(event)}\n\n`);
  emit({type:'response.created',response:{id,status:'in_progress',output:[]}});
  if(hang){onRequest?.();return;}
  emit({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}});
  emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'FIXTURE_OK'});
  emit({type:'response.output_item.done',output_index:0,item});
  emit({type:'response.completed',response:{id,status:'completed',model:receivedModel,output:[item],usage:{input_tokens:10,output_tokens:3,total_tokens:13}}});res.end();
});
api.listen(0,'127.0.0.1');await once(api,'listening');const port=(api.address() as any).port;
await writeFile(join(home,'config.toml'),`model = "mobile-fixture"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.fixture]\nname = "Local test fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "CMW_TEST_KEY"\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
const runtime=new AppServer(resolveCodex(),{...process.env,CODEX_HOME:home,CMW_TEST_KEY:fixtureKey,CODEX_PROFILE:''});
const control=new Control(new Ledger(':memory:'),runtime);
function event(method:string,predicate:(p:Json)=>boolean=()=>true):Promise<Json>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{runtime.off('event',listener);reject(new Error(`Native event timeout: ${method}`));},20_000);
  const listener=(e:Json)=>{if(e.method===method&&predicate(e.params)){clearTimeout(timer);runtime.off('event',listener);resolve(e.params);}};runtime.on('event',listener);
});}
try{
  await runtime.start();const config=await runtime.rpc('config/read',{cwd:project,includeLayers:false});assert.equal(config.config.model_provider,'fixture');
  const started=await runtime.rpc('thread/start',{cwd:project});assert.equal(started.model,'mobile-fixture');assert.equal(started.modelProvider,'fixture');assert.equal(started.approvalPolicy,'never');assert.equal(started.sandbox.type,'dangerFullAccess');
  await assert.rejects(runtime.rpc('thread/read',{threadId:started.thread.id,includeTurns:true}),/not materialized yet/);
  const done=event('turn/completed');await runtime.rpc('turn/start',{threadId:started.thread.id,input:[{type:'text',text:'Return the fixture response.'}]});const completed=await done;
  assert.equal(completed.turn.status,'completed');assert.equal(receivedModel,'mobile-fixture');assert.equal(receivedAuth,true);
  const read=await runtime.rpc('thread/read',{threadId:started.thread.id,includeTurns:true});assert.ok(read.thread.turns.some((t:Json)=>t.items.some((i:Json)=>i.text==='FIXTURE_OK')));
  hang=true;const reachedFixture=new Promise<void>(resolve=>{onRequest=resolve;});const active=await runtime.rpc('turn/start',{threadId:started.thread.id,input:[{type:'text',text:'Wait for the fixture.'}]});await reachedFixture;
  const steer=await runtime.rpc('turn/steer',{threadId:started.thread.id,expectedTurnId:active.turn.id,input:[{type:'text',text:'Additional fixture input.'}]});assert.equal(steer.turnId,active.turn.id);
  const stopped=event('turn/completed',p=>p.turn.id===active.turn.id);await runtime.rpc('turn/interrupt',{threadId:started.thread.id,turnId:active.turn.id});assert.equal((await stopped).turn.status,'interrupted');
  hang=false;
  const managed=await control.handle({id:'create',action:'session.create',payload:{cwd:project,opId:`${Date.now()}:${randomUUID()}`}});assert.equal(managed.state,'accepted');
  const view=await control.read(managed.threadId);assert.equal(view.canControl,true);assert.equal(view.turns.length,0);assert.equal(view.model,'mobile-fixture');
  const managedDone=event('turn/completed',p=>p.threadId===managed.threadId);
  const submitted=await control.handle({id:'send',action:'turn.send',payload:{threadId:view.id,source:view.source,generation:view.generation,expectedTurnId:null,text:'Return fixture response.',opId:`${Date.now()}:${randomUUID()}`}});assert.equal(submitted.state,'accepted');await managedDone;
  const final=await control.read(view.id);assert.equal(final.activeTurnId,null);assert.equal(final.canControl,true);
  const profiled=new AppServer(resolveCodex(),{...process.env,CODEX_HOME:home,CMW_TEST_KEY:fixtureKey,CODEX_PROFILE:'mobile'});
  try{await assert.rejects(profiled.start(),/不支持/);}finally{profiled.close();}
  console.log(JSON.stringify({result:'passed',nativeBinary:resolveCodex(),checks:['custom provider inherited','model and env credential reached local fixture','existing access policy inherited','thread start/read including empty session','streamed reply','steer expected turn','interrupt same turn','connector create/read/send','unsupported profile rejected explicitly'],deepseekLiveTest:false}));
}finally{
  control.close();api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));
  // Wait only for this isolated child to release its temporary database on Windows.
  for(let attempt=0;attempt<20;attempt++){try{await removeTestTemp(dir);break;}catch{await new Promise(r=>setTimeout(r,100));}}
}
