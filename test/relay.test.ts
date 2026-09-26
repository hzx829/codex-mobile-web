import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {createRelay} from '../src/server/relay.js';
import {Ledger} from '../src/connector/ledger.js';
import {BrowserPreview} from '../src/connector/browser-preview.js';
import {Control} from '../src/connector/control.js';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTestTemp} from '../scripts/test-temp.js';
import {MAX_FRAME,FILE_CHUNK_SIZE} from '../src/shared/types.js';
import {receiveFile} from '../web/file-download.js';

function waitFrame(ws:WebSocket,predicate:(v:any)=>boolean):Promise<any>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.off('message',listen);reject(Error('frame timeout'));},3000);
  const listen=(b:any)=>{const value=JSON.parse(b.toString());if(predicate(value)){clearTimeout(timer);ws.off('message',listen);resolve(value);}};ws.on('message',listen);
});}

test('a binary result larger than one frame downloads intact through the selected machine and session',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-download-')),name='演示 deck.pptx',source=Buffer.alloc(MAX_FRAME+137);
  for(let i=0;i<source.length;i++)source[i]=i%251;
  await writeFile(join(dir,name),source);
  class Runtime extends EventEmitter{requests=new Map();rpc(){throw Error('must use the selected desktop session');}close(){}}
  class Desktop extends EventEmitter{async follow(id:string){assert.equal(id,'selected-session');return {id,cwd:dir,turns:[]};}close(){}}
  const control=new Control(new Ledger(':memory:'),new Runtime() as any,new Desktop() as any),relay=createRelay('file-test-token');
  relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const url=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;let largestFrame=0,chunkCount=0;
  async function peer(role:string){
    const socket=new WebSocket(url);await once(socket,'open');const ready=waitFrame(socket,m=>m.type==='ready');
    socket.send(JSON.stringify({type:'hello',role,token:'file-test-token',machineId:'download-pc',name:'Test PC'}));await ready;return socket;
  }
  try {
    const connector=await peer('connector'),phone=await peer('phone');
    connector.on('message',async raw=>{
      const request=JSON.parse(raw.toString());if(request.type!=='request')return;
      let response;
      try{response={result:await control.handle(request)};}catch(e:any){response={error:{code:e.code,message:e.message}};}
      const frame=JSON.stringify({type:'response',id:request.id,...response});largestFrame=Math.max(largestFrame,Buffer.byteLength(frame));
      connector.send(frame);
    });
    async function request(action:string,payload:any,machineId='download-pc'){
      const id=randomUUID(),response=waitFrame(phone,m=>m.type==='response'&&m.id===id);
      phone.send(JSON.stringify({type:'request',id,machineId,action,payload:{threadId:'selected-session',...payload}}));
      const result=await response;if(result.error)throw result.error;return result.result;
    }
    await assert.rejects(request('file.read',{path:name},'other-pc'),(e:any)=>e.code==='offline');
    const file=await request('file.read',{path:name});
    assert.equal(file.name,name);assert.equal(file.size,source.length);assert.equal(file.data,undefined);assert.equal(file.text,undefined);
    const offsets:number[]=[];
    const blob=await receiveFile(file,offset=>{chunkCount++;return request('file.download',{path:file.path,revision:file.revision,offset});},new AbortController().signal,bytes=>offsets.push(bytes));
    assert.equal(Buffer.compare(Buffer.from(await blob.arrayBuffer()),source),0);
    assert.equal(offsets.at(-1),source.length);assert.equal(chunkCount,Math.ceil(source.length/FILE_CHUNK_SIZE));assert.ok(largestFrame<MAX_FRAME);
    connector.close();await once(connector,'close');
    await assert.rejects(request('file.download',{path:file.path,revision:file.revision,offset:0}),(e:any)=>e.code==='offline');
  }finally{await relay.close();control.close();await removeTestTemp(dir);}
});
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
    if(req.url==='/no-frame'){res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"frame-ancestors 'none'");res.end('standalone only');return;}
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
        const result=message.action==='preview.start'?local.start(message.payload.url,message.payload.threadId):{stopped:local.stopForThread(message.payload.sessionId,message.payload.threadId)};
        connector.send(JSON.stringify({type:'response',id:message.id,result}));
      }else if(message.type==='preview.stop')local.stop(message.sessionId,message.threadId);
      else if(message.type?.startsWith('proxy.'))local.handle(message);
    });
    assert.equal((await fetch(proxy)).status,401);
    const response=waitFrame(owner,m=>m.type==='response'&&m.id==='open');
    owner.send(JSON.stringify({type:'request',id:'open',machineId:'pc',action:'preview.start',payload:{threadId:'thread-a',url:`http://127.0.0.1:${(app.address() as any).port}/`}}));
    const session=(await response).result;
    assert.equal(session.threadId,'thread-a');
    assert.equal(session.previewPort,(relay.previewServer.address() as any).port);
    const entry=await fetch(`${proxy}/_bridge/enter?ticket=${session.ticket}`,{redirect:'manual'});
    assert.equal(entry.status,302);const cookie=entry.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${proxy}/_bridge/enter?ticket=${session.ticket}`)).status,401);
    assert.equal((await fetch(`${proxy}/_bridge/enter?session=${session.sessionId}&ticket=${session.ticket}`,{headers:{cookie},redirect:'manual'})).status,302);
    assert.equal((await fetch(`${proxy}/_bridge/enter?session=another&ticket=${session.ticket}`,{headers:{cookie},redirect:'manual'})).status,401);
    const restricted=await fetch(`${proxy}/no-frame`,{headers:{cookie}});assert.equal(restricted.headers.get('x-frame-options'),'DENY');assert.equal(restricted.headers.get('content-security-policy'),"frame-ancestors 'none'");
    const policy=(await fetch(`http://127.0.0.1:${(relay.server.address() as any).port}/health`)).headers.get('content-security-policy')!;
    assert.ok(policy.includes(`frame-src ${proxy};`));assert.ok(policy.includes("script-src 'self';"));
    assert.match(await (await fetch(proxy,{headers:{cookie}})).text(),/Local app/);
    assert.deepEqual(await (await fetch(`${proxy}/api`,{headers:{cookie}})).json(),{ok:true});
    assert.equal(await (await fetch(`${proxy}/echo`,{method:'POST',headers:{cookie},body:'hello'})).text(),'hello');
    assert.equal((await fetch(`${proxy}/redirect`,{headers:{cookie},redirect:'manual'})).headers.get('location'),`${proxy}/api`);
    const socket=new WebSocket(`${proxy.replace('http','ws')}/hot`,{headers:{cookie,origin:proxy}});await once(socket,'open');
    const echoed=once(socket,'message');socket.send('hot reload');assert.equal((await echoed)[0].toString(),'hot reload');socket.close();
    assert.equal(wsOrigin,`http://127.0.0.1:${(app.address() as any).port}`);
    const wrongThread=waitFrame(other,m=>m.type==='response'&&m.id==='wrong-thread');
    other.send(JSON.stringify({type:'request',id:'wrong-thread',machineId:'pc',action:'preview.stop',payload:{sessionId:session.sessionId,threadId:'thread-b'}}));
    assert.equal((await wrongThread).result.stopped,false);
    assert.match(await (await fetch(proxy,{headers:{cookie}})).text(),/Local app/);
    const missingThread=waitFrame(other,m=>m.type==='response'&&m.id==='missing-thread');
    other.send(JSON.stringify({type:'request',id:'missing-thread',machineId:'pc',action:'preview.start',payload:{url:'http://localhost:5173'}}));
    assert.equal((await missingThread).error.code,'invalid');
    owner.close();
    assert.match(await (await fetch(proxy,{headers:{cookie}})).text(),/Local app/);
    const stopped=waitFrame(other,m=>m.type==='response'&&m.id==='stop');
    other.send(JSON.stringify({type:'request',id:'stop',machineId:'pc',action:'preview.stop',payload:{sessionId:session.sessionId,threadId:'thread-a'}}));
    await stopped;
    assert.equal((await fetch(proxy,{headers:{cookie}})).status,401);
    const nextResponse=waitFrame(other,m=>m.type==='response'&&m.id==='open-b');
    other.send(JSON.stringify({type:'request',id:'open-b',machineId:'pc',action:'preview.start',payload:{threadId:'thread-b',url:`http://127.0.0.1:${(app.address() as any).port}/api`}}));
    const next=(await nextResponse).result;assert.equal(next.threadId,'thread-b');
    const nextEntry=await fetch(`${proxy}/_bridge/enter?session=${next.sessionId}&ticket=${next.ticket}`,{redirect:'manual'});
    assert.equal(nextEntry.headers.get('location'),'/api');const nextCookie=nextEntry.headers.get('set-cookie')!.split(';')[0];
    const staleStop=waitFrame(other,m=>m.type==='response'&&m.id==='stale-stop');
    other.send(JSON.stringify({type:'request',id:'stale-stop',machineId:'pc',action:'preview.stop',payload:{sessionId:session.sessionId,threadId:'thread-a'}}));
    assert.equal((await staleStop).result.stopped,false);
    assert.equal((await fetch(proxy,{headers:{cookie}})).status,401);
    assert.deepEqual(await (await fetch(`${proxy}/api`,{headers:{cookie:nextCookie}})).json(),{ok:true});
    other.close();connector.close();
  }finally{await relay.close();appWs.close();await new Promise<void>(resolve=>app.close(()=>resolve()));}
});

test('a disconnected pending preview only cleans up its own session, leaving the next thread active',async()=>{
  const token='preview-pending-test',relay=createRelay(token,undefined,0);
  relay.server.listen(0,'127.0.0.1');relay.previewServer.listen(0,'127.0.0.1');await Promise.all([once(relay.server,'listening'),once(relay.previewServer,'listening')]);
  const url=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`,proxy=`http://127.0.0.1:${(relay.previewServer.address() as any).port}`;
  async function peer(role:string){
    const socket=new WebSocket(url);await once(socket,'open');const ready=waitFrame(socket,m=>m.type==='ready');
    socket.send(JSON.stringify({type:'hello',role,token,machineId:'pc',name:'Test PC'}));await ready;return socket;
  }
  try{
    const connector=await peer('connector'),a=await peer('phone'),b=await peer('phone'),stops:any[]=[];
    connector.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='preview.stop')stops.push(message);});
    const pending=waitFrame(connector,m=>m.type==='request'&&m.payload.threadId==='a');
    a.send(JSON.stringify({type:'request',id:'open-a',machineId:'pc',action:'preview.start',payload:{threadId:'a',url:'http://localhost:5173'}}));
    const requestA=await pending;
    const active=waitFrame(connector,m=>m.type==='request'&&m.payload.threadId==='b');
    b.send(JSON.stringify({type:'request',id:'open-b',machineId:'pc',action:'preview.start',payload:{threadId:'b',url:'http://localhost:3000'}}));
    const requestB=await active,responseB=waitFrame(b,m=>m.type==='response'&&m.id==='open-b');
    connector.send(JSON.stringify({type:'response',id:requestB.id,result:{sessionId:'preview-b',threadId:'b',url:'http://localhost:3000'}}));
    const sessionB=(await responseB).result;
    a.close();await once(a,'close');
    const cleaned=waitFrame(connector,m=>m.type==='preview.stop'&&m.sessionId==='preview-a');
    connector.send(JSON.stringify({type:'response',id:requestA.id,result:{sessionId:'preview-a',threadId:'a',url:'http://localhost:5173'}}));
    assert.equal((await cleaned).threadId,'a');
    assert.deepEqual(stops,[{type:'preview.stop',sessionId:'preview-a',threadId:'a'}]);
    const entry=await fetch(`${proxy}/_bridge/enter?session=${sessionB.sessionId}&ticket=${sessionB.ticket}`,{redirect:'manual'});
    assert.equal(entry.status,302);
  }finally{await relay.close();}
});
