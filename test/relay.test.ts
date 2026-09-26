import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {createRelay} from '../src/server/relay.js';
import {Ledger} from '../src/connector/ledger.js';
import {BrowserPreview} from '../src/connector/browser-preview.js';

function waitFrame(ws:WebSocket,predicate:(v:any)=>boolean):Promise<any>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.off('message',listen);reject(Error('frame timeout'));},3000);
  const listen=(b:any)=>{const value=JSON.parse(b.toString());if(predicate(value)){clearTimeout(timer);ws.off('message',listen);resolve(value);}};ws.on('message',listen);
});}
test('token gate, machine routing and receipt recovery after phone disconnect',async()=>{
  const token='test-token-not-a-real-secret-123456789';const relay=createRelay(token);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const port=(relay.server.address() as any).port,url=`ws://127.0.0.1:${port}/ws`,ledger=new Ledger(':memory:');let executions=0;
  async function peer(role:string,auth=token){const ws=new WebSocket(url);await once(ws,'open');const result=auth===token?waitFrame(ws,m=>m.type==='ready'):once(ws,'close');ws.send(JSON.stringify({type:'hello',role,token:auth,machineId:'pc',name:'Test PC'}));await result;return ws;}
  try{
    const bad=await peer('phone','wrong');assert.equal(bad.readyState,WebSocket.CLOSED);
    const connector=await peer('connector');
    connector.on('message',async raw=>{
      const m=JSON.parse(raw.toString());if(m.type!=='request')return;
      const result=await ledger.run(m.payload.opId,{action:m.action},async()=>{executions++;await new Promise(r=>setTimeout(r,35));return {threadId:'s',turnId:'t'};});
      connector.send(JSON.stringify({type:'response',id:m.id,result}));
    });
    const first=await peer('phone');const opId=`${Date.now()}:${randomUUID()}`;
    const request={type:'request',id:'original',machineId:'pc',action:'turn.send',payload:{opId}};
    first.send(JSON.stringify(request));await new Promise(r=>setTimeout(r,10));first.terminate();
    await new Promise(r=>setTimeout(r,60));assert.equal(connector.readyState,WebSocket.OPEN);
    const second=await peer('phone');const response=waitFrame(second,m=>m.id==='retry');second.send(JSON.stringify({...request,id:'retry'}));
    assert.equal((await response).result.state,'accepted');assert.equal(executions,1);
    const offline=waitFrame(second,m=>m.id==='no-pc');second.send(JSON.stringify({...request,id:'no-pc',machineId:'missing'}));assert.equal((await offline).error.code,'offline');
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200);
  }finally{await relay.close();ledger.close();}
});

test('preview tunnels HTTP and WebSocket only for its owner',async()=>{
  const app=createServer(async(req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:`http://127.0.0.1:${(app.address() as any).port}/api`});res.end();return;}
    if(req.url==='/api'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));return;}
    if(req.url==='/echo'){let body='';for await(const chunk of req)body+=chunk;res.end(body);return;}
    res.setHeader('Content-Type','text/html');res.end('<h1>Local app</h1>');
  });
  let wsOrigin='';const appWs=new WebSocketServer({server:app,path:'/hot'});appWs.on('connection',(socket,req)=>{wsOrigin=req.headers.origin||'';socket.on('message',data=>socket.send(data));});
  app.listen(0,'127.0.0.1');await once(app,'listening');
  const token='preview-test-token-123456789',relay=createRelay(token,undefined,0);
  relay.server.listen(0,'127.0.0.1');relay.previewServer.listen(0,'127.0.0.1');await Promise.all([once(relay.server,'listening'),once(relay.previewServer,'listening')]);
  const url=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`,proxy=`http://127.0.0.1:${(relay.previewServer.address() as any).port}`;
  async function peer(role:'phone'|'connector'){
    const ws=new WebSocket(url);await once(ws,'open');const ready=waitFrame(ws,m=>m.type==='ready');
    ws.send(JSON.stringify({type:'hello',role,token,machineId:'pc',name:'Test PC'}));await ready;return ws;
  }
  try{
    const connector=await peer('connector'),owner=await peer('phone'),other=await peer('phone'),local=new BrowserPreview();
    local.on('message',message=>connector.send(JSON.stringify(message)));
    local.on('ended',event=>connector.send(JSON.stringify({type:'preview.ended',...event})));
    connector.on('message',raw=>{
      const message=JSON.parse(raw.toString());
      if(message.type==='request'){
        const result=message.action==='preview.start'?local.start(message.payload.url):(local.stop(message.payload.sessionId),{stopped:true});
        connector.send(JSON.stringify({type:'response',id:message.id,result}));
      }else if(message.type==='preview.stop')local.stop(message.sessionId);
      else if(message.type?.startsWith('proxy.'))local.handle(message);
    });
    assert.equal((await fetch(proxy)).status,401);
    const response=waitFrame(owner,m=>m.type==='response'&&m.id==='open');
    owner.send(JSON.stringify({type:'request',id:'open',machineId:'pc',action:'preview.start',payload:{url:`http://127.0.0.1:${(app.address() as any).port}/`}}));
    const session=(await response).result;
    assert.equal(session.previewPort,(relay.previewServer.address() as any).port);
    const entry=await fetch(`${proxy}/_bridge/enter?ticket=${session.ticket}`,{redirect:'manual'});
    assert.equal(entry.status,302);const cookie=entry.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${proxy}/_bridge/enter?ticket=${session.ticket}`)).status,401);
    assert.match(await (await fetch(proxy,{headers:{cookie}})).text(),/Local app/);
    assert.deepEqual(await (await fetch(`${proxy}/api`,{headers:{cookie}})).json(),{ok:true});
    assert.equal(await (await fetch(`${proxy}/echo`,{method:'POST',headers:{cookie},body:'hello'})).text(),'hello');
    assert.equal((await fetch(`${proxy}/redirect`,{headers:{cookie},redirect:'manual'})).headers.get('location'),`${proxy}/api`);
    const socket=new WebSocket(`${proxy.replace('http','ws')}/hot`,{headers:{cookie,origin:proxy}});await once(socket,'open');
    const echoed=once(socket,'message');socket.send('hot reload');assert.equal((await echoed)[0].toString(),'hot reload');socket.close();
    assert.equal(wsOrigin,`http://127.0.0.1:${(app.address() as any).port}`);
    owner.close();
    assert.match(await (await fetch(proxy,{headers:{cookie}})).text(),/Local app/);
    const stopped=waitFrame(other,m=>m.type==='response'&&m.id==='stop');
    other.send(JSON.stringify({type:'request',id:'stop',machineId:'pc',action:'preview.stop',payload:{sessionId:session.sessionId}}));
    await stopped;
    assert.equal((await fetch(proxy,{headers:{cookie}})).status,401);
    other.close();connector.close();
  }finally{await relay.close();appWs.close();await new Promise<void>(resolve=>app.close(()=>resolve()));}
});
