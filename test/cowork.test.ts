import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';
import {WebSocket, type WebSocketServer} from 'ws';
import {CoworkBridge, coworkPairing} from '../src/connector/cowork.js';
import {coworkThreadUrl} from '../src/shared/cowork.js';
import {home,parseLocation} from '../web/route-state.js';

const project='/project/12345678-1234-1234-1234-123456789abc';
const thread='/cowork/cse_01MExample1234';
const sidebar='/cowork/cse_01Pinned1234';
const source=readFileSync('src/cowork-extension/cowork-page.js','utf8');

function snapshot(html:string,path:string,kind:string,expectedPath=''){
  const {document,HTMLElement}=parseHTML(html);
  Object.defineProperty(HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
  const value=runInNewContext(source+'\ncoworkSnapshot(kind,expectedPath)',{
    document, location:{origin:'https://claude.ai',pathname:path}, URL,kind,expectedPath,
  });
  return JSON.parse(JSON.stringify(value));
}

test('Cowork catalog reads project links and sidebar sessions from the paired origin',()=>{
  const value=snapshot(`<nav>
    <a href="${sidebar}">Codex mobile web integration</a>
    <a href="${sidebar}?ignored=1">Duplicate</a>
    <a href="https://elsewhere.invalid${thread}">External</a>
    <a href="${thread}" hidden>Hidden</a>
    <a href="/chat/12345678-1234-1234-1234-123456789abc">Ordinary chat</a>
  </nav><main>
    <a href="${project}">岭安 (LingAn)</a>
    <a href="${thread}">Link in page content</a>
  </main>`,'/projects','catalog','/projects');
  assert.deepEqual(value,{data:[{id:sidebar,title:'Codex mobile web integration'}],projects:[{id:project,name:'岭安 (LingAn)'}]});
});

test('Cowork project cards exclude unrelated sidebar threads',()=>{
  const value=snapshot(`<nav><a href="${sidebar}">Pinned</a></nav><main><a href="${thread}">Project task</a></main>`,project,'project',project);
  assert.deepEqual(value,{data:[{id:thread,title:'Project task'}],projects:[]});
});

test('Cowork reads rendered message text only from the requested conversation',()=>{
  const html='<html><head><title>Task | Claude</title></head><body><aside data-testid="assistant-message">Unrelated</aside><main><div data-testid="user-message">Question</div><article data-testid="assistant-message"><div class="font-claude-response"><div class="standard-markdown">Answer</div></div></article></main></body></html>';
  assert.deepEqual(snapshot(html,thread,'thread',thread),{title:'Task',messages:[{id:'0',role:'user',text:'Question'},{id:'1',role:'assistant',text:'Answer'}]});
  assert.deepEqual(snapshot(html,sidebar,'thread',thread),{failure:'loading'});
  assert.deepEqual(snapshot(html,'/login','thread',thread),{failure:'login'});
});

test('Cowork routes restore project and conversation and constrain the external link',()=>{
  const route={...home,project,cowork:thread};
  assert.deepEqual(parseLocation({cmwRoute:route,cmwMachine:'pc'}),{route,machine:'pc'});
  assert.equal(parseLocation({cmwRoute:{...route,cowork:'//other.invalid/x'},cmwMachine:'pc'}),null);
  assert.equal(coworkThreadUrl(thread),'https://claude.ai'+thread);
  assert.equal(coworkThreadUrl(thread+'?token=bad'),'');
});


test('Cowork loopback requires pairing and serves the catalog and conversation over one connection',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'cmw-cowork-'));
  const bridge=new CoworkBridge(dir,0);
  t.after(()=>{bridge.close();rmSync(dir,{recursive:true,force:true});});
  await bridge.ready;
  const {server}=bridge as unknown as {server:WebSocketServer};
  const pairing=coworkPairing(dir,(server.address() as AddressInfo).port);
  await assert.rejects(bridge.handle('cowork.list'),{code:'browser_offline'});
  const wrongOrigin=new WebSocket(pairing.url,{origin:'https://claude.ai'});
  assert.equal((await once(wrongOrigin,'close'))[0],4403);
  const origin='chrome-extension://'+('a'.repeat(32));
  const wrongToken=new WebSocket(pairing.url,{origin});
  await once(wrongToken,'open');
  wrongToken.send(JSON.stringify({type:'hello',token:'0'.repeat(64)}));
  assert.equal((await once(wrongToken,'close'))[0],4401);
  const socket=new WebSocket(pairing.url,{origin});
  await once(socket,'open');
  socket.send(JSON.stringify({type:'hello',token:pairing.token}));
  assert.deepEqual(JSON.parse(String((await once(socket,'message'))[0])),{type:'ready'});
  const respond=(id:string,result:object)=>socket.send(JSON.stringify({type:'response',id,result}));
  const requests:Array<{id:string;action:string;payload:unknown}>=[];
  socket.on('message',data=>{
    requests.push(JSON.parse(data.toString()));
    if(requests.length!==2)return;
    respond(requests[1].id,{title:'Project task',messages:[{id:'a',role:'assistant',text:'Done'}]});
    respond(requests[0].id,{data:[{id:thread,title:'Project task'}],projects:[{id:project,name:'Delegate'}]});
  });
  await assert.rejects(bridge.handle('cowork.send'),{code:'unsupported'});
  const [catalog,view]=await Promise.all([bridge.handle('cowork.list'),bridge.handle('cowork.read',{conversationId:thread})]);
  assert.deepEqual(requests.map(({action,payload})=>({action,payload})),[
    {action:'cowork.list',payload:{project:''}},{action:'cowork.read',payload:{conversationId:thread}},
  ]);
  assert.deepEqual(catalog,{data:[{id:thread,title:'Project task',updatedAt:0,running:false}],hasMore:false,projects:[{id:project,name:'Delegate',path:'Delegate'}]});
  assert.deepEqual(view,{title:'Project task',messages:[{id:'a',role:'assistant',text:'Done'}]});
});
