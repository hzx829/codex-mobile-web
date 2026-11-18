import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {ChatGPTBridge} from '../src/connector/chatgpt.js';
import {home,parseLocation} from '../web/route-state.js';

const id='12345678-1234-1234-1234-123456789abc',origin='chrome-extension://'+'a'.repeat(32);
const opId=()=>`${Date.now()}:${randomUUID()}`;
async function setup(t:any){
  const dir=await mkdtemp(join(tmpdir(),'chatgpt-bridge-'));
  const bridge=new ChatGPTBridge(dir,0);await bridge.ready;
  const port=(bridge as any).server.address().port;
  const {token}=JSON.parse(await readFile(join(dir,'chatgpt-pairing.json'),'utf8'));
  t.after(async()=>{const server=(bridge as any).server,closed=once(server,'close');bridge.close();await closed;await rm(dir,{recursive:true,force:true});});
  async function attach(options:{origin?:string;token?:string;cowork?:boolean}={}){
    const ws=new WebSocket(`ws://127.0.0.1:${port}/chatgpt`,{origin:options.origin||origin});
    const closed=once(ws,'close');
    await once(ws,'open');
    const response=once(ws,'message');
    ws.send(JSON.stringify({type:'hello',token:options.token||token,cowork:options.cowork}));
    if(options.origin||options.token)return {ws,closed};
    assert.equal(JSON.parse(String((await response)[0])).type,'ready');return {ws,closed};
  }
  return {bridge,attach};
}
test('ChatGPT bridge requires both extension origin and local pairing token',async t=>{
  const {bridge,attach}=await setup(t);
  assert.equal((await bridge.handle('chatgpt.status')).connected,false);
  const badOrigin=await attach({origin:'https://chatgpt.com'});assert.equal((await badOrigin.closed)[0],4403);
  const badToken=await attach({token:'wrong'});assert.equal((await badToken.closed)[0],4401);
  const {ws}=await attach();
  ws.on('message',data=>{const message=JSON.parse(String(data));if(message.type==='request')ws.send(JSON.stringify({type:'response',id:message.id,result:{pageReady:true}}));});
  assert.equal((await bridge.handle('chatgpt.status')).connected,true);
});
test('ChatGPT send is exactly once per operation ID and preserves uncertain disconnects',async t=>{
  const {bridge,attach}=await setup(t),{ws,closed}=await attach();let calls=0;
  ws.on('message',data=>{
    const message=JSON.parse(String(data));if(message.type!=='request')return;calls++;
    if(message.payload.text==='disconnect'){ws.close();return;}
    assert.equal(message.action,'send');
    ws.send(JSON.stringify({type:'response',id:message.id,result:{submitted:true,conversationId:id}}));
  });
  const payload={conversationId:id,text:'hello',opId:opId()};
  const [first,second]=await Promise.all([bridge.handle('chatgpt.send',payload),bridge.handle('chatgpt.send',payload)]);
  assert.equal(first.state,'accepted');assert.deepEqual(first,second);assert.equal(calls,1);
  await assert.rejects(bridge.handle('chatgpt.send',{...payload,text:'different'}),{code:'conflict'});
  const uncertain={...payload,text:'disconnect',opId:opId()};
  assert.equal((await bridge.handle('chatgpt.send',uncertain)).state,'uncertain');await closed;
  assert.equal((await bridge.handle('chatgpt.send',uncertain)).state,'uncertain');assert.equal(calls,2);
  assert.equal((await bridge.handle('chatgpt.operation',{opId:uncertain.opId})).state,'uncertain');
});
test('ChatGPT routing validates IDs and prevents reload during an in-flight request',async t=>{
  const {bridge,attach}=await setup(t),{ws}=await attach();
  await assert.rejects(bridge.handle('chatgpt.read',{conversationId:'../../secrets'}),{code:'invalid'});
  await assert.rejects(bridge.handle('chatgpt.send',{conversationId:id,text:'',opId:opId()}),{code:'invalid'});
  const received=once(ws,'message'),request=bridge.handle('chatgpt.read',{conversationId:id});
  const message=JSON.parse(String((await received)[0]));
  assert.throws(()=>bridge.prepareReload(),{code:'active'});
  await assert.rejects(bridge.handle('chatgpt.list'),{code:'active'});
  ws.send(JSON.stringify({type:'response',id:message.id,result:{messages:[]}}));await request;
  bridge.prepareReload();await assert.rejects(bridge.handle('chatgpt.list'),{code:'active'});
});
test('saved ChatGPT routes never select a Codex thread',()=>{
  assert.deepEqual(parseLocation({cmwRoute:{thread:'codex-thread',project:'C:/work',newChat:true,chat:id},cmwMachine:'pc'}),{route:{...home,chat:id},machine:'pc'});
  assert.equal(parseLocation({cmwRoute:{...home,chat:'invalid'},cmwMachine:'pc'}),null);
});

test('Cowork uses the paired extension for independent read-only requests',async t=>{
  const {bridge,attach}=await setup(t),{ws}=await attach({cowork:true});
  const requests:any[]=[],thread='/cowork/cse_01MExample1234',project=`/project/${id}`;
  ws.on('message',raw=>{
    const request=JSON.parse(String(raw));requests.push(request);
    if(requests.length!==2)return;
    for(const entry of requests.toReversed()){
      const result=entry.action==='cowork.list'?{data:[{id:thread,title:'历史会话'},{id:thread+'/invalid',title:'历史会话'}],projects:[{id:project,name:'Delegate'}]}
        :{title:'历史会话',messages:[{id:'1',role:'user',text:'Hi'}]};
      ws.send(JSON.stringify({type:'response',id:entry.id,result}));
    }
  });
  await assert.rejects(bridge.handleCowork('cowork.send',{conversationId:thread}),{code:'unsupported'});
  await assert.rejects(bridge.handleCowork('cowork.read',{conversationId:'https://wrong.example/'}),{code:'invalid'});
  const [list,view]=await Promise.all([bridge.handleCowork('cowork.list',{search:'历史'}),bridge.handleCowork('cowork.read',{conversationId:thread})]);
  assert.deepEqual(list.data,[{id:thread,title:'历史会话',updatedAt:0,running:false}]);
  assert.deepEqual(list.projects,[{id:project,name:'Delegate',path:'Delegate'}]);
  assert.equal(view.messages[0].text,'Hi');
});
