import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {createServer,request} from 'node:http';
import {WebSocketServer} from 'ws';
import {createRelay} from '../src/server/relay.js';
import {Ledger} from '../src/connector/ledger.js';
import {BrowserPreview} from '../src/connector/browser-preview.js';
import {Control} from '../src/connector/control.js';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTestTemp} from '../scripts/test-temp.js';
import {MAX_FRAME,FILE_CHUNK_SIZE} from '../src/shared/types.js';
import {receiveFile} from '../web/file-download.js';

function waitFrame(ws:WebSocket,predicate:(v:any)=>boolean):Promise<any>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.off('message',listen);reject(Error('frame timeout'));},3000);
  const listen=(b:any)=>{const value=JSON.parse(b.toString());if(predicate(value)){clearTimeout(timer);ws.off('message',listen);resolve(value);}};ws.on('message',listen);
});}

test('a guest token registers only its bound connector', async () => {
  const token = 'main-fixture-token-for-guest-tests', restricted = 'guest-fixture-token-for-guest-tests';
  const relay = createRelay(token, undefined, 0, [{machineId: 'guest-pc', token: restricted}]);
  relay.server.listen(0, '127.0.0.1');await once(relay.server, 'listening');
  const url = `ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  async function hello(fields: object, accept: boolean) {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    const result = accept ? waitFrame(socket, frame => frame.type === 'ready') : once(socket, 'close');
    socket.send(JSON.stringify({type: 'hello', name: 'fixture', ...fields}));
    return result;
  }
  try {
    await hello({role: 'connector', token, machineId: 'personal'}, true);
    assert.equal((await hello({role: 'phone', token: restricted, machineId: 'guest-pc'}, false))[0], 4401);
    assert.equal((await hello({role: 'connector', token: restricted, machineId: 'personal'}, false))[0], 4401);
    await hello({role: 'connector', token: restricted, machineId: 'guest-pc', guest: true, services: ['claude', 'claude', 'unknown'], protocol: 1, features: ['live', 'live', 'bad name', 7]}, true);
    const phone = await hello({role: 'phone', token}, true);
    assert.deepEqual(phone.machines, [
      {id: 'personal', name: 'fixture'},
      {id: 'guest-pc', name: 'fixture', guest: true, services: ['claude'], protocol: 1, features: ['live']},
    ]);
  } finally {await relay.close();}
});

async function httpRequest(url:string,options:{method?:string;headers?:Record<string,string>;body?:string;redirect?:string}={}){
  // These are protocol tests. Node HTTP accepts Windows' low ephemeral ports.
  return new Promise<{status:number;headers:Headers;bytes:Buffer;text:()=>Promise<string>;json:()=>Promise<any>}>((resolve,reject)=>{
    const req=request(url,{method:options.method,headers:options.headers},async res=>{
      try{
        const chunks:Buffer[]=[];for await(const chunk of res)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),body=bytes.toString();
        const headers=new Headers();for(const [key,value] of Object.entries(res.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
        resolve({status:res.statusCode!,headers,bytes,text:async()=>body,json:async()=>JSON.parse(body)});
      }catch(error){reject(error);}
    });req.on('error',reject);req.end(options.body);
  });
}

test('only versioned assets are cached and gzip preserves their content',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-static-')),script='const greeting="hello";\n'.repeat(1000);
  await mkdir(join(dir,'assets'));await writeFile(join(dir,'assets','index-a1B2c3D4.js'),script);await writeFile(join(dir,'index.html'),'<main>Current entry</main>');
  await writeFile(join(dir,'assets','pdf.worker-a1B2c3D4.mjs'),script);
  await mkdir(join(dir,'pdfjs'));await writeFile(join(dir,'pdfjs','decoder.wasm'),Buffer.from([0,97,115,109]));
  const relay=createRelay('static-test-token',dir);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const base=`http://127.0.0.1:${(relay.server.address() as any).port}`;
  try{
    const asset=await httpRequest(base+'/assets/index-a1B2c3D4.js',{headers:{'Accept-Encoding':'gzip'}});
    assert.equal(asset.status,200);assert.equal(asset.headers.get('content-encoding'),'gzip');assert.match(asset.headers.get('cache-control')!,/immutable/);
    assert.equal(asset.headers.get('vary'),'Accept-Encoding');assert.equal(gunzipSync(asset.bytes).toString(),script);assert.ok(asset.bytes.length<script.length/10);
    for(const encoding of ['', 'br, gzip;q=0']){
      const plain=await httpRequest(base+'/assets/index-a1B2c3D4.js',{headers:{'Accept-Encoding':encoding}});
      assert.equal(plain.headers.get('content-encoding'),null);assert.equal(await plain.text(),script);
    }
    for(const path of ['/','/health','/assets/missing-a1B2c3D4.js'])assert.equal((await httpRequest(base+path)).headers.get('cache-control'),'no-store');
    const worker=await httpRequest(base+'/assets/pdf.worker-a1B2c3D4.mjs',{headers:{'Accept-Encoding':'gzip'}});
    assert.match(worker.headers.get('content-type')!,/javascript/);assert.equal(gunzipSync(worker.bytes).toString(),script);
    const policy=worker.headers.get('content-security-policy')!;
    assert.match(policy,/worker-src 'self';/);assert.match(policy,/font-src 'self' blob:;/);
    assert.match(policy,/'wasm-unsafe-eval'/);assert.doesNotMatch(policy,/'unsafe-eval'|'unsafe-inline'.*script-src/);
    const wasm=await httpRequest(base+'/pdfjs/decoder.wasm');assert.equal(wasm.headers.get('content-type'),'application/wasm');
  }finally{await relay.close();await removeTestTemp(dir);}
});

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
    const image=`data:image/png;base64,${Buffer.alloc(2*1024*1024).toString('base64')}`;
    const imageRequest=JSON.stringify({...request,id:'image',payload:{opId:`${Date.now()}:${randomUUID()}`,images:[image,image]}});
    assert.ok(Buffer.byteLength(imageRequest)<MAX_FRAME);
    const received=waitFrame(second,m=>m.type==='received'&&m.id==='image'),imageResult=waitFrame(second,m=>m.type==='response'&&m.id==='image');
    second.send(imageRequest);
    await received;assert.equal((await imageResult).result.state,'accepted');
    const fileRequest=JSON.stringify({...request,id:'file',action:'file.uploadChunk',payload:{opId:`${Date.now()}:${randomUUID()}`,threadId:'s',id:randomUUID(),offset:0,data:Buffer.alloc(FILE_CHUNK_SIZE).toString('base64')}});
    assert.ok(Buffer.byteLength(fileRequest)<MAX_FRAME);
    const fileReceived=waitFrame(second,m=>m.type==='received'&&m.id==='file'),fileResult=waitFrame(second,m=>m.type==='response'&&m.id==='file');
    second.send(fileRequest);await fileReceived;assert.equal((await fileResult).result.state,'accepted');
    assert.equal((await httpRequest(`http://127.0.0.1:${port}/health`)).status,200);
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
    assert.equal((await httpRequest(proxy)).status,401);
    const response=waitFrame(owner,m=>m.type==='response'&&m.id==='open');
    owner.send(JSON.stringify({type:'request',id:'open',machineId:'pc',action:'preview.start',payload:{threadId:'thread-a',url:`http://127.0.0.1:${(app.address() as any).port}/`}}));
    const session=(await response).result;
    assert.equal(session.threadId,'thread-a');
    assert.equal(session.previewPort,(relay.previewServer.address() as any).port);
    const entry=await httpRequest(`${proxy}/_bridge/enter?ticket=${session.ticket}`,{redirect:'manual'});
    assert.equal(entry.status,302);const cookie=entry.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await httpRequest(`${proxy}/_bridge/enter?ticket=${session.ticket}`)).status,401);
    assert.equal((await httpRequest(`${proxy}/_bridge/enter?session=${session.sessionId}&ticket=${session.ticket}`,{headers:{cookie},redirect:'manual'})).status,302);
    assert.equal((await httpRequest(`${proxy}/_bridge/enter?session=another&ticket=${session.ticket}`,{headers:{cookie},redirect:'manual'})).status,401);
    const restricted=await httpRequest(`${proxy}/no-frame`,{headers:{cookie}});assert.equal(restricted.headers.get('x-frame-options'),'DENY');assert.equal(restricted.headers.get('content-security-policy'),"frame-ancestors 'none'");
    const policy=(await httpRequest(`http://127.0.0.1:${(relay.server.address() as any).port}/health`)).headers.get('content-security-policy')!;
    assert.ok(policy.includes(`frame-src ${proxy} http: https:;`));assert.ok(policy.includes("connect-src 'self' ws: wss: http: https:;"));assert.ok(policy.includes("script-src 'self' 'wasm-unsafe-eval';"));
    assert.match(await (await httpRequest(proxy,{headers:{cookie}})).text(),/Local app/);
    assert.deepEqual(await (await httpRequest(`${proxy}/api`,{headers:{cookie}})).json(),{ok:true});
    assert.equal(await (await httpRequest(`${proxy}/echo`,{method:'POST',headers:{cookie},body:'hello'})).text(),'hello');
    assert.equal((await httpRequest(`${proxy}/redirect`,{headers:{cookie},redirect:'manual'})).headers.get('location'),`${proxy}/api`);
    const socket=new WebSocket(`${proxy.replace('http','ws')}/hot`,{headers:{cookie,origin:proxy}});await once(socket,'open');
    const echoed=once(socket,'message');socket.send('hot reload');assert.equal((await echoed)[0].toString(),'hot reload');socket.close();
    assert.equal(wsOrigin,`http://127.0.0.1:${(app.address() as any).port}`);
    const wrongThread=waitFrame(other,m=>m.type==='response'&&m.id==='wrong-thread');
    other.send(JSON.stringify({type:'request',id:'wrong-thread',machineId:'pc',action:'preview.stop',payload:{sessionId:session.sessionId,threadId:'thread-b'}}));
    assert.equal((await wrongThread).result.stopped,false);
    assert.match(await (await httpRequest(proxy,{headers:{cookie}})).text(),/Local app/);
    const missingThread=waitFrame(other,m=>m.type==='response'&&m.id==='missing-thread');
    other.send(JSON.stringify({type:'request',id:'missing-thread',machineId:'pc',action:'preview.start',payload:{url:'http://localhost:5173'}}));
    assert.equal((await missingThread).error.code,'invalid');
    owner.close();
    assert.match(await (await httpRequest(proxy,{headers:{cookie}})).text(),/Local app/);
    const stopped=waitFrame(other,m=>m.type==='response'&&m.id==='stop');
    other.send(JSON.stringify({type:'request',id:'stop',machineId:'pc',action:'preview.stop',payload:{sessionId:session.sessionId,threadId:'thread-a'}}));
    await stopped;
    assert.equal((await httpRequest(proxy,{headers:{cookie}})).status,401);
    const nextResponse=waitFrame(other,m=>m.type==='response'&&m.id==='open-b');
    other.send(JSON.stringify({type:'request',id:'open-b',machineId:'pc',action:'preview.start',payload:{threadId:'thread-b',url:`http://127.0.0.1:${(app.address() as any).port}/api`}}));
    const next=(await nextResponse).result;assert.equal(next.threadId,'thread-b');
    const nextEntry=await httpRequest(`${proxy}/_bridge/enter?session=${next.sessionId}&ticket=${next.ticket}`,{redirect:'manual'});
    assert.equal(nextEntry.headers.get('location'),'/api');const nextCookie=nextEntry.headers.get('set-cookie')!.split(';')[0];
    const staleStop=waitFrame(other,m=>m.type==='response'&&m.id==='stale-stop');
    other.send(JSON.stringify({type:'request',id:'stale-stop',machineId:'pc',action:'preview.stop',payload:{sessionId:session.sessionId,threadId:'thread-a'}}));
    assert.equal((await staleStop).result.stopped,false);
    assert.equal((await httpRequest(proxy,{headers:{cookie}})).status,401);
    assert.deepEqual(await (await httpRequest(`${proxy}/api`,{headers:{cookie:nextCookie}})).json(),{ok:true});
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
    const entry=await httpRequest(`${proxy}/_bridge/enter?session=${sessionB.sessionId}&ticket=${sessionB.ticket}`,{redirect:'manual'});
    assert.equal(entry.status,302);
  }finally{await relay.close();}
});

test('live frames reach only the phone watching that thread, and phone frames are compressed',async()=>{
  const token='test-token-not-a-real-secret-123456789';const relay=createRelay(token);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const url=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  async function peer(role:string){const ws=new WebSocket(url);await once(ws,'open');const ready=waitFrame(ws,m=>m.type==='ready');ws.send(JSON.stringify({type:'hello',role,token,machineId:'pc',name:'PC'}));assert.deepEqual((await ready).features,['live','sync']);return ws;}
  try{
    const connector=await peer('connector');
    connector.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='request')connector.send(JSON.stringify({type:'response',id:m.id,result:{id:m.payload.threadId,text:'x'.repeat(50_000)}}));});
    const watching=await peer('phone'),other=await peer('phone');
    assert.ok(Object.keys((watching as any)._extensions||{}).includes('permessage-deflate'),'Phones negotiate compression.');
    const read=waitFrame(watching,m=>m.type==='response'&&m.id==='read');
    watching.send(JSON.stringify({type:'request',id:'read',machineId:'pc',action:'session.read',payload:{threadId:'a',watch:true}}));
    assert.equal((await read).result.text.length,50_000);
    other.send(JSON.stringify({type:'watch',machineId:'pc',threadId:'b'}));await new Promise(r=>setTimeout(r,20));
    const seen:string[]=[];other.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='live')seen.push(m.threadId);});
    const frame=waitFrame(watching,m=>m.type==='live');
    connector.send(JSON.stringify({type:'live',threadId:'a',generation:'g',turnId:'u',ops:[{i:'1',o:0,t:'hi'}]}));
    assert.deepEqual(await frame,{type:'live',threadId:'a',generation:'g',turnId:'u',ops:[{i:'1',o:0,t:'hi'}],machineId:'pc'});
    const second=waitFrame(other,m=>m.type==='live');
    connector.send(JSON.stringify({type:'live',threadId:'b',generation:'g',turnId:'u',ops:[]}));
    await second;assert.deepEqual(seen,['b']);
    other.send(JSON.stringify({type:'watch',machineId:null,threadId:null}));await new Promise(r=>setTimeout(r,20));
    connector.send(JSON.stringify({type:'live',threadId:'b',generation:'g',turnId:'u',ops:[]}));await new Promise(r=>setTimeout(r,50));
    assert.deepEqual(seen,['b'],'Leaving the thread stops its frames.');
  }finally{await relay.close();}
});

test('a traced request carries the relay round trip and the computer timing; others carry none', async () => {
  const token='trace-fixture-token-for-relay-tests';
  const relay=createRelay(token,undefined,0);
  relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const url=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  const join=async(fields:object)=>{const socket=new WebSocket(url);await once(socket,'open');const ready=waitFrame(socket,frame=>frame.type==='ready');socket.send(JSON.stringify({type:'hello',token,...fields}));await ready;return socket;};
  const connector=await join({role:'connector',machineId:'pc',name:'pc'}),phone=await join({role:'phone'});
  // The connector answers every request with a timing of its own, asked for or not.
  connector.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='request')connector.send(JSON.stringify({type:'response',id:m.id,result:{traced:m.trace===true},trace:{handleMs:3,now:Date.now(),steps:{read:2}}}));});
  try{
    const ask=async(id:string,trace:boolean)=>{const answer=waitFrame(phone,frame=>frame.type==='response'&&frame.id===id);phone.send(JSON.stringify({type:'request',id,machineId:'pc',action:'info',payload:{},...trace?{trace:true}:{}}));return answer;};
    const timed=await ask('a',true);
    assert.equal(timed.result.traced,true,'The connector is asked to time it.');
    assert.equal(timed.trace.handleMs,3);
    assert.deepEqual(timed.trace.steps,{read:2});
    assert.ok(timed.trace.relayMs>=0);
    const plain=await ask('b',false);
    assert.equal(plain.result.traced,false);
    assert.equal(plain.trace,undefined);
  }finally{phone.close();connector.close();await relay.close();}
});

test('synced frames reach only phones following that app’s thread; Codex frames keep their own watchers', async () => {
  const token='sync-fixture-token-for-relay-tests';
  const relay=createRelay(token,undefined,0);
  relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const url=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  const join=async(fields:object)=>{const socket=new WebSocket(url);await once(socket,'open');const ready=waitFrame(socket,frame=>frame.type==='ready');socket.send(JSON.stringify({type:'hello',token,...fields}));const value=await ready;return {socket,ready:value};};
  const {socket:connector}=await join({role:'connector',machineId:'pc',name:'pc'});
  const {socket:claudePhone,ready}=await join({role:'phone'}),{socket:codexPhone}=await join({role:'phone'});
  assert.ok(ready.features.includes('sync'));
  connector.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='request')connector.send(JSON.stringify({type:'response',id:m.id,result:{epoch:'e',seq:0,head:{},order:[],entries:[],hasMore:false}}));});
  const received=(socket:WebSocket)=>{const list:any[]=[];socket.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='live')list.push(m);});return list;};
  const claudeFrames=received(claudePhone),codexFrames=received(codexPhone);
  try{
    const opened=waitFrame(claudePhone,frame=>frame.type==='response'&&frame.id==='o');
    claudePhone.send(JSON.stringify({type:'request',id:'o',machineId:'pc',action:'sync.open',payload:{service:'claude',threadId:'same'}}));
    await opened;
    codexPhone.send(JSON.stringify({type:'watch',machineId:'pc',threadId:'same'}));
    await new Promise(resolve=>setTimeout(resolve,50));
    connector.send(JSON.stringify({type:'live',service:'claude',threadId:'same',epoch:'e',seq:1}));
    connector.send(JSON.stringify({type:'live',threadId:'same',generation:'g',turnId:'t'}));
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(claudeFrames.map(frame=>[frame.service,frame.seq,frame.machineId]),[['claude',1,'pc']]);
    assert.deepEqual(codexFrames.map(frame=>[frame.service,frame.turnId]),[[undefined,'t']]);
  }finally{claudePhone.close();codexPhone.close();connector.close();await relay.close();}
});
