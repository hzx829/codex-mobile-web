// Two isolated native app-servers share a temporary home; no real thread or account is used.
import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {EventEmitter,once} from 'node:events';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {AppServer,resolveCodex} from '../src/connector/app-server.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError,type Json} from '../src/shared/types.js';
import {removeTestTemp} from './test-temp.js';

const dir=await mkdtemp(join(tmpdir(),'cmw-ownership-')),home=join(dir,'codex'),project=join(dir,'project');await mkdir(home);await mkdir(project);
const local=JSON.parse(await readFile('.local/config.json','utf8').catch(()=>'{}'));
const bin=resolveCodex(process.env.CODEX_BIN||local.codexBin),key=randomUUID();
let hold=true,held:ServerResponse|undefined,requests=0,reached:()=>void=()=>{};
function finish(res:ServerResponse){
  const id=`resp_${randomUUID()}`,item={id:`msg_${randomUUID()}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'OWNERSHIP_OK',annotations:[]}]};
  const emit=(value:Json)=>res.write(`data: ${JSON.stringify(value)}\n\n`);
  emit({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}});
  emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'OWNERSHIP_OK'});
  emit({type:'response.output_item.done',output_index:0,item});
  emit({type:'response.completed',response:{id,status:'completed',model:'ownership-fixture',output:[item],usage:{input_tokens:10,output_tokens:3,total_tokens:13}}});res.end();
}
const api=createServer(async(req,res)=>{
  for await(const _ of req){}
  requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({type:'response.created',response:{id:`resp_${randomUUID()}`,status:'in_progress',output:[]}})}\n\n`);
  if(hold){held=res;reached();}else finish(res);
});
api.listen(0,'127.0.0.1');await once(api,'listening');
await writeFile(join(home,'config.toml'),`model = "ownership-fixture"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.fixture]\nname = "Ownership fixture"\nbase_url = "http://127.0.0.1:${(api.address() as any).port}/v1"\nwire_api = "responses"\nenv_key = "CMW_TEST_KEY"\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
const env={...process.env,CODEX_HOME:home,CODEX_PROFILE:'',CMW_TEST_KEY:key};
const runtime=new AppServer(bin,env),other=new AppServer(bin,env);
class OfflineDesktop extends EventEmitter {clientId='';states=new Map();async follow(){throw new BridgeError('no_owner','isolated fixture');}close(){}}
const control=new Control(new Ledger(':memory:'),runtime,new OfflineDesktop() as any,async()=>[],()=>null);
const call=(action:any,payload:Json)=>control.handle({id:randomUUID(),action,payload:{...payload,opId:`${Date.now()}:${randomUUID()}`}});
function completed(id:string){return new Promise<void>((resolve,reject)=>{
  const timeout=setTimeout(()=>{runtime.off('event',listener);reject(new Error('turn did not complete'));},20000);
  const listener=(e:Json)=>{if(e.method==='turn/completed'&&e.params.threadId===id){clearTimeout(timeout);runtime.off('event',listener);resolve();}};runtime.on('event',listener);
});}
try{
  await runtime.start();await other.start();
  const created=await call('session.create',{cwd:project});assert.equal(created.state,'accepted');const id=created.threadId;
  const send=()=>call('turn.send',{threadId:id,source:'connector',generation:control.generation,expectedTurnId:null,text:'Return ownership fixture response.'});
  const active=new Promise<void>(resolve=>{reached=resolve;}),done=completed(id);
  assert.equal((await send()).state,'accepted');await active;
  await assert.rejects(other.rpc('thread/resume',{threadId:id},3000),/another|locked|active writer|already.*open/i);
  hold=false;finish(held!);await done;await (control as any).exclusive(id,async()=>{});
  assert.equal((await runtime.rpc('thread/loaded/list')).data.includes(id),false,'Completion must release the native lock.');
  const resumed=await other.rpc('thread/resume',{threadId:id},3000);assert.equal(resumed.thread.id,id);
  const detached=await control.read(id);assert.equal(detached.source,'connector');assert.equal(detached.canControl,true);
  assert.equal((await runtime.rpc('thread/loaded/list')).data.includes(id),false,'Reading must remain detached.');
  const refused=await send();assert.equal(refused.state,'failed');assert.equal(requests,1,'A lock conflict must not send a second prompt.');
  await other.unsubscribe(id);
  const again=completed(id);assert.equal((await send()).state,'accepted');await again;await (control as any).exclusive(id,async()=>{});
  assert.equal(requests,2);assert.equal((await runtime.rpc('thread/loaded/list')).data.includes(id),false);
  assert.equal((await other.rpc('thread/resume',{threadId:id})).thread.id,id);
  console.log(JSON.stringify({result:'passed',nativeVersion:runtime.version,checks:['active native ownership blocks another app','completion releases native ownership','history reads stay detached','external owner prevents duplicate execution','mobile resumes only after external release'],liveChatGPT:false,uiAcceptance:false}));
}finally{
  await other.stop();await runtime.stop();control.close();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));
  await removeTestTemp(dir);
}
